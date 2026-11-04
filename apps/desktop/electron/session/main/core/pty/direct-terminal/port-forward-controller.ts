/**
 * #6264 端口转发(port-forward.ts)的生产装配 + 渲染层那几问。
 * 连法问的是直连终端同一个宿主(DirectTerminalResolver,purpose = forward),文案由渲染层写。
 */
import { spawn } from '@gugu/core/local/childProcess';
import net from 'node:net';
import { err, ok } from '@gugu/session-shared';
import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { remotePortKey, remotePortLinkChannel } from '@shared/remote-port-link';
import { remotePortDetectedChannel, remotePortsChangedChannel, type RemotePortsSnapshot } from '@shared/remote-ports';
import { bindRemoteBrowser, setRemoteLoopbackForwarding, unbindRemoteBrowser } from '../../browser/remote-loopback-requests';
import { directSshResolver } from './controller';
import { createDetectedPorts } from './detected-ports';
import { localPortProbes } from './local-port-probes';
import { sshKeyInstallChannel } from '@shared/ssh-key-install';
import { createPortForwards, isLocalPortFree, PortForwardError, type ForwardChild } from './port-forward';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  return env;
}

/** 两种地址族、回环与通配都看(port-forward.ts isLocalPortFree 的说明)。 */
function isPortFree(port: number): Promise<boolean> {
  return isLocalPortFree(port, localPortProbes);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** 转发转好没有:ssh 只绑 127.0.0.1。 */
function canConnect(port: number): Promise<boolean> {
  return localPortProbes.canConnect(port, '127.0.0.1');
}

function spawnSsh(command: string, args: string[], env: Record<string, string>): ForwardChild {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  return {
    onExit: (handler) => {
      child.once('exit', (code, signal) => handler({ exitCode: code, signal }));
      child.once('error', () => handler({ exitCode: null, signal: null }));
    },
    onStderr: (handler) => {
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => handler(chunk));
    },
    kill: () => {
      child.kill();
    },
  };
}

export const portForwards = createPortForwards({
  resolve: async ({ deviceId, sessionId, localPort, remotePort }) => {
    const resolver = directSshResolver();
    if (!resolver) return null;
    const spec = await resolver({ deviceId, sessionId, purpose: { kind: 'forward', localPort, remotePort } });
    if (!spec) return null;
    return {
      command: spec.command,
      args: spec.args,
      label: spec.label,
      classifyExit: (info) => ({ reason: spec.classifyExit(info).reason }),
      ...(spec.askpass ? { askpass: spec.askpass } : {}),
      ...(spec.mux ? { mux: spec.mux } : {}),
    };
  },
  spawn: spawnSsh,
  isPortFree,
  freePort,
  canConnect,
  emit: (link) => {
    events.emit(remotePortLinkChannel, link, remotePortKey(link.deviceId, link.remotePort));
    // 「端口」页签那张表跟着变(每条转发一步一次,量级 = 人开页签的次数)。
    events.emit(remotePortsChangedChannel, { deviceId: link.deviceId }, link.deviceId);
  },
  onKeyInstall: (label, outcome) => events.emit(sshKeyInstallChannel, { label, outcome }),
  env: stringEnv(),
});

/** #6264 终端 / agent 输出里发现的端口(detected-ports.ts)。 */
export const detectedPorts = createDetectedPorts({
  onChanged: (deviceId) => events.emit(remotePortsChangedChannel, { deviceId }, deviceId),
  onDetected: (entry) => events.emit(remotePortDetectedChannel, entry),
});

// 远端浏览器页签里页面自己的 localhost 请求(remote-loopback-requests.ts)走同一套转发。
setRemoteLoopbackForwarding({
  remoteForLocal: (deviceId, localPort) => portForwards.remoteForLocal(deviceId, localPort),
  open: (input) => portForwards.open(input),
  status: (deviceId, remotePort) => portForwards.status(deviceId, remotePort),
});

// 应用退出时 ssh 子进程不一定跟着走(macOS 上没有 SIGHUP):主动收掉。
process.once('exit', () => portForwards.closeAll());

function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : null;
}

export const remotePortsController = createRPCController({
  /** 要用那台机器上的某个端口(浏览器页签加载 localhost:<端口> 前):转好了回本机端口。 */
  open: async (args: { deviceId: string; sessionId: string; remotePort: number; holder: string; exactLocalPort?: boolean }) => {
    const deviceId = String(args?.deviceId ?? '');
    const sessionId = String(args?.sessionId ?? '');
    const holder = String(args?.holder ?? '');
    const remotePort = validPort(args?.remotePort);
    if (!ID.test(deviceId) || !ID.test(sessionId) || !holder || remotePort === null) {
      return err({ type: 'invalid' as const });
    }
    try {
      const localPort = await portForwards.open({ deviceId, sessionId, remotePort, holder, exactLocalPort: args?.exactLocalPort === true });
      return ok({ localPort });
    } catch (error) {
      const reason = error instanceof PortForwardError ? error.reason : 'unknown';
      return err({ type: 'failed' as const, reason });
    }
  },

  release: (args: { deviceId: string; remotePort: number; holder: string }) => {
    const remotePort = validPort(args?.remotePort);
    if (remotePort === null) return err({ type: 'invalid' as const });
    portForwards.release({ deviceId: String(args?.deviceId ?? ''), remotePort, holder: String(args?.holder ?? '') });
    return ok();
  },

  answerPrompt: (args: { deviceId: string; remotePort: number; promptId: string; value: string | null; installKey?: boolean }) => {
    const remotePort = validPort(args?.remotePort);
    if (remotePort === null) return err({ type: 'invalid' as const });
    return ok({
      answered: portForwards.answerPrompt({
        deviceId: String(args?.deviceId ?? ''),
        remotePort,
        promptId: String(args?.promptId ?? ''),
        value: typeof args?.value === 'string' ? args.value : null,
        installKey: args?.installKey === true,
      }),
    });
  },

  /** #6264「端口」页签那张表:转着的 + 输出里发现的(在那台机器上监听的由渲染层另问那台机器)。 */
  list: (args: { deviceId: string }) => {
    const deviceId = String(args?.deviceId ?? '');
    if (!ID.test(deviceId)) return err({ type: 'invalid' as const });
    const snapshot: RemotePortsSnapshot = { forwards: portForwards.list(deviceId), detected: detectedPorts.list(deviceId) };
    return ok(snapshot);
  },

  /** 「停止转发」:不管谁还拿着都撤掉(照 VS Code Stop Forwarding Port)。 */
  stop: (args: { deviceId: string; remotePort: number }) => {
    const remotePort = validPort(args?.remotePort);
    const deviceId = String(args?.deviceId ?? '');
    if (remotePort === null || !ID.test(deviceId)) return err({ type: 'invalid' as const });
    return ok({ stopped: portForwards.stop(deviceId, remotePort) });
  },

  /** 从表上拿掉一个发现的端口(它没在转)。 */
  forget: (args: { deviceId: string; remotePort: number }) => {
    const remotePort = validPort(args?.remotePort);
    const deviceId = String(args?.deviceId ?? '');
    if (remotePort === null || !ID.test(deviceId)) return err({ type: 'invalid' as const });
    detectedPorts.forget(deviceId, remotePort);
    return ok();
  },

  /**
   * 渲染层在别的机器上的会话输出里发现的端口:终端输出(`terminal`)与聊天记录(`agent`)。
   * 输出经那台机器的连接到这台电脑的渲染层,扫在那里(machine-session-wiring.ts)。
   */
  detect: (args: { deviceId: string; sessionId: string; ports: number[]; source?: 'terminal' | 'agent' }) => {
    const deviceId = String(args?.deviceId ?? '');
    const sessionId = String(args?.sessionId ?? '');
    const ports = Array.isArray(args?.ports) ? args.ports.map(validPort).filter((port): port is number => port !== null) : [];
    if (!ID.test(deviceId) || !ID.test(sessionId)) return err({ type: 'invalid' as const });
    detectedPorts.detect(deviceId, sessionId, ports.slice(0, 20), args?.source === 'terminal' ? 'terminal' : 'agent');
    return ok();
  },

  /** 远端浏览器页签登记:页面里的 localhost 请求按这台机器转(remote-loopback-requests.ts)。 */
  bindBrowser: (args: { browserId: string; deviceId: string; sessionId: string }) => {
    const browserId = String(args?.browserId ?? '');
    const deviceId = String(args?.deviceId ?? '');
    const sessionId = String(args?.sessionId ?? '');
    if (!browserId || !ID.test(deviceId) || !ID.test(sessionId)) return err({ type: 'invalid' as const });
    bindRemoteBrowser(browserId, { deviceId, sessionId });
    return ok();
  },

  /** 页签关了:不再代它转,它拿着的转发一并放手。 */
  unbindBrowser: (args: { browserId: string }) => {
    const browserId = String(args?.browserId ?? '');
    if (!browserId) return err({ type: 'invalid' as const });
    unbindRemoteBrowser(browserId);
    portForwards.releaseHolder(browserId);
    return ok();
  },

  status: (args: { deviceId: string; remotePort: number }) => {
    const remotePort = validPort(args?.remotePort);
    if (remotePort === null) return err({ type: 'invalid' as const });
    return ok({ link: portForwards.status(String(args?.deviceId ?? ''), remotePort) });
  },
});
