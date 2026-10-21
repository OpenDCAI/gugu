/**
 * #6264 会话右侧工作区的「浏览器」:打开那台机器上的 `http://localhost:<端口>` 时,这台电脑经 SSH 把一个本机端口
 * 转过去再加载(照 VS Code Remote-SSH 的端口转发;只给用 SSH 装上的机器 —— 只经云端连着的机器没有直连通道,
 * 网页流量 ❌ 走云端消息额度)。
 *
 * 生命周期(一条转发 = 一个 ssh 进程):
 *  · 同一台机器的同一个远端端口只转一条,各个浏览器页签各自「持有」它(holder);最后一个持有者放手就杀掉进程。
 *  · 本机端口先试与远端同号(VS Code 的做法:地址栏里还是 localhost:3000);被这台电脑上别的程序占着就换一个空闲的,
 *    ❌ 把人带到这台电脑上的另一个服务上去。
 *  · 「转好了」= 本机端口真的能连上(ssh 已经在监听),❌ 进程起来就算。
 *  · ssh 要问人(密码 / 口令 / 新主机指纹)时经 askpass 报给渲染层画成提问卡片;问着的时候不计超时。
 *  · 转好之后 ssh 断了(睡眠、换网):报 closed;持有者下次加载时再转一次(尽量还用原来那个本机端口)。
 *  · 有复用连接时(mac / Linux),转发骑在这台机器那条共享连接上(照 VS Code:终端、文件、端口转发同一条连接,
 *    只认证一次):先确保连接在(不在才认证、才问人),再 `ssh -O forward` 加一条、放手时 `-O cancel` 撤掉。
 *    这时没有一个「转发进程」可盯:持有者再要这条转发时先看本机端口还连不连得上,连不上就重转。
 *    没有复用连接(Windows 自带的 OpenSSH)时照旧一条转发一个 ssh 进程。
 *
 * 进程、端口探测、时钟都注入:单测不起真 ssh 也能把每一步钉住。
 */
import type { SshKeyInstallOutcome, SshPrompt } from '@shared/ssh-prompt';
import { remotePortKey, type RemotePortLink, type RemotePortReason } from '@shared/remote-port-link';
import type { DirectTerminalAskpass } from './ssh-connect';

export type ForwardChild = {
  onExit(handler: (info: { exitCode: number | null; signal: number | string | null }) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  kill(): void;
};

export type ForwardSpec = {
  command: string;
  args: string[];
  label: string;
  classifyExit(info: { exitCode: number | null; signal: number | string | null; tail: string }): {
    reason: RemotePortReason;
  };
  askpass?: DirectTerminalAskpass;
  /** 骑在共享连接上时的三条 ssh(见 controller.ts SshMuxForward);没有 = 单开一条连接转发。 */
  mux?: { ensureArgs: string[]; forwardArgs: string[]; cancelArgs: string[] };
};

export type PortForwardDeps = {
  /** 宿主给的连法;这台机器不能直连 ⇒ null。 */
  resolve(input: { deviceId: string; sessionId: string; localPort: number; remotePort: number }): Promise<ForwardSpec | null>;
  spawn(command: string, args: string[], env: Record<string, string>): ForwardChild;
  /** 这个本机端口此刻空不空(回环地址上没人监听)。 */
  isPortFree(port: number): Promise<boolean>;
  /** 让系统给一个空闲端口。 */
  freePort(): Promise<number>;
  /** 本机端口能不能连上(ssh 在不在监听)。 */
  canConnect(port: number): Promise<boolean>;
  emit(link: RemotePortLink): void;
  /** #6264「下次免密」做完了(装好 / 没做成):渲染层弹一条提示。可能在这条转发关掉之后才来。 */
  onKeyInstall?(label: string, outcome: SshKeyInstallOutcome): void;
  env?: Record<string, string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 没人问问题时,等「转好了」最多多久。 */
  readyTimeoutMs?: number;
  pollMs?: number;
};

/**
 * #6264 这台电脑上的某个端口到底空不空 —— 两种地址族都要看(VS Code 同样吃过这个亏:本机 `localhost` 在浏览器里
 * 可能落到 ::1,也可能落到 127.0.0.1)。2026-09-24 实撞:ssh 转发占住了 127.0.0.1:8765,而这台电脑上另有一个
 * Python 服务听在 `*:8765`(IPv6 通配),探「能不能占住 ::1」却成功了(macOS 上带 SO_REUSEADDR 的具体地址可以
 * 叠在通配地址上),于是浏览器按 `localhost` → ::1 连到了这台电脑自己的服务。
 * 所以:①四个地址(两个回环 + 两个通配)都得占得住;②两个回环地址上都**连不上**(有人在听就能连上,
 * 不管它是按什么地址、什么选项绑的)。任何一条不满足都算占用。
 */
export type LocalPortProbes = {
  canListen(port: number, host: string): Promise<boolean>;
  canConnect(port: number, host: string): Promise<boolean>;
};

export const LOCAL_BIND_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'] as const;
export const LOCAL_CONNECT_HOSTS = ['127.0.0.1', '::1'] as const;

export async function isLocalPortFree(port: number, probes: LocalPortProbes): Promise<boolean> {
  for (const host of LOCAL_CONNECT_HOSTS) if (await probes.canConnect(port, host)) return false;
  for (const host of LOCAL_BIND_HOSTS) if (!(await probes.canListen(port, host))) return false;
  return true;
}

export class PortForwardError extends Error {
  constructor(readonly reason: RemotePortReason, message?: string) {
    super(message ?? reason);
    this.name = 'PortForwardError';
  }
}

type Forward = {
  key: string;
  deviceId: string;
  remotePort: number;
  holders: Set<string>;
  link: RemotePortLink;
  child: ForwardChild | null;
  askpass: DirectTerminalAskpass | null;
  opening: Promise<number> | null;
  /** 上一次转到的本机端口:断了再转时优先还用它(已经打开的页面地址不变)。 */
  lastLocalPort: number | null;
  /** 骑在共享连接上的这条转发怎么撤(`ssh -O cancel …`);单开连接时为 null。 */
  cancel: { command: string; args: string[] } | null;
};

const TAIL_BYTES = 4096;
/** 本机端口被抢 / 绑不上:换一个再试。 */
const BIND_FAILED = /Address already in use|cannot listen to port|bind \[[^\]]*\]:\d+: /i;
/** 那台机器不许转发。 */
const FORWARD_REFUSED = /remote port forwarding failed|administratively prohibited|Could not request local forwarding/i;

export function createPortForwards(deps: PortForwardDeps) {
  const forwards = new Map<string, Forward>();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readyTimeoutMs = deps.readyTimeoutMs ?? 20_000;
  const pollMs = deps.pollMs ?? 100;

  const publish = (forward: Forward, patch: Partial<RemotePortLink>): void => {
    forward.link = { ...forward.link, ...patch };
    deps.emit(forward.link);
  };

  async function pickLocalPort(forward: Forward): Promise<number> {
    for (const candidate of [forward.lastLocalPort, forward.remotePort]) {
      if (candidate && (await deps.isPortFree(candidate))) return candidate;
    }
    return systemFreePort();
  }

  /** 系统给的空闲端口只看了 127.0.0.1:再按两种地址族核一遍,占着就换(最多试几次)。 */
  async function systemFreePort(): Promise<number> {
    let port = await deps.freePort();
    for (let tries = 0; tries < 8 && !(await deps.isPortFree(port)); tries++) port = await deps.freePort();
    return port;
  }

  /** 起一次 ssh,等它真的在本机端口上监听。成功 = 本机端口;失败抛 PortForwardError。 */
  async function dial(forward: Forward, sessionId: string, localPort: number): Promise<number> {
    const spec = await deps.resolve({ deviceId: forward.deviceId, sessionId, localPort, remotePort: forward.remotePort });
    if (!spec) throw new PortForwardError('not-direct');
    if (spec.mux) return dialShared(forward, spec, spec.mux, localPort);
    publish(forward, { label: spec.label });
    forward.askpass = spec.askpass ?? null;
    let prompt: SshPrompt | null = null;
    let promptSettledAt = now();
    spec.askpass?.onPrompt((next) => {
      prompt = next;
      if (!next) promptSettledAt = now();
      publish(forward, { prompt: next });
    });
    let cancelled = false;
    spec.askpass?.onSettled((_prompt, outcome) => {
      if (outcome === 'cancelled') cancelled = true;
    });
    spec.askpass?.onKeyInstall?.((outcome) => deps.onKeyInstall?.(spec.label, outcome));
    spec.askpass?.newRound();
    let tail = '';
    let exited: { exitCode: number | null; signal: number | string | null } | null = null;
    const child = deps.spawn(spec.command, spec.args, { ...(deps.env ?? {}), ...(spec.askpass?.env ?? {}) });
    forward.child = child;
    child.onStderr((chunk) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
    });
    child.onExit((info) => {
      exited = info;
      if (forward.child !== child) return;
      forward.child = null;
      closeAskpass(forward);
      // 转好之后断了:持有者下次加载再转;还在转的时候断了由下面的等待循环报原因。
      if (forward.link.phase === 'ready') publish(forward, { phase: 'closed', localPort: null, prompt: null });
    });

    for (;;) {
      if (exited) {
        const info = exited as { exitCode: number | null; signal: number | string | null };
        if (cancelled) throw new PortForwardError('cancelled');
        if (BIND_FAILED.test(tail)) throw new PortForwardError('refused', 'bind-failed');
        if (FORWARD_REFUSED.test(tail)) throw new PortForwardError('forward-refused', tail.trim());
        throw new PortForwardError(spec.classifyExit({ ...info, tail }).reason, tail.trim());
      }
      if (!prompt && (await deps.canConnect(localPort))) {
        // 转好了 = 登上了:这次答密码时勾了「下次免密」就去装钥匙(在转发收起 askpass 之前取走请求)。
        spec.askpass?.authenticated?.();
        return localPort;
      }
      if (!prompt && now() - promptSettledAt > readyTimeoutMs) {
        child.kill();
        throw new PortForwardError('timeout');
      }
      await sleep(pollMs);
    }
  }

  /**
   * 跑一条 ssh 等它退出;要问人时(只有「确保连接在」那一条会问)照单开连接时一样把提问报出去、不计超时。
   * 退出码 0 = 成功;否则按输出认原因抛 PortForwardError。
   */
  async function runStep(
    forward: Forward,
    spec: ForwardSpec,
    args: string[],
    askpass: DirectTerminalAskpass | null
  ): Promise<void> {
    let prompt: SshPrompt | null = null;
    let promptSettledAt = now();
    let cancelled = false;
    if (askpass) {
      forward.askpass = askpass;
      askpass.onPrompt((next) => {
        prompt = next;
        if (!next) promptSettledAt = now();
        publish(forward, { prompt: next });
      });
      askpass.onSettled((_prompt, outcome) => {
        if (outcome === 'cancelled') cancelled = true;
      });
      askpass.newRound();
    }
    let tail = '';
    let exited: { exitCode: number | null; signal: number | string | null } | null = null;
    const child = deps.spawn(spec.command, args, { ...(deps.env ?? {}), ...(askpass?.env ?? {}) });
    forward.child = child;
    child.onStderr((chunk) => {
      tail = (tail + chunk).slice(-TAIL_BYTES);
    });
    child.onExit((info) => {
      exited = info;
    });
    for (;;) {
      if (exited) {
        const info = exited as { exitCode: number | null; signal: number | string | null };
        if (forward.child === child) forward.child = null;
        if (info.exitCode === 0) return;
        if (cancelled) throw new PortForwardError('cancelled');
        // `-O forward` 绑不上本机端口时 ssh 说的是这一句(实测 OpenSSH 10:「Port forwarding failed」)。
        if (BIND_FAILED.test(tail) || /forwarding request failed|Port forwarding failed/i.test(tail)) {
          throw new PortForwardError('refused', 'bind-failed');
        }
        if (FORWARD_REFUSED.test(tail)) throw new PortForwardError('forward-refused', tail.trim());
        throw new PortForwardError(spec.classifyExit({ ...info, tail }).reason, tail.trim());
      }
      if (!prompt && now() - promptSettledAt > readyTimeoutMs) {
        child.kill();
        throw new PortForwardError('timeout');
      }
      await sleep(pollMs);
    }
  }

  /** 骑在共享连接上转:确保连接在 → `-O forward` → 本机端口真的能连上。 */
  async function dialShared(
    forward: Forward,
    spec: ForwardSpec,
    mux: NonNullable<ForwardSpec['mux']>,
    localPort: number
  ): Promise<number> {
    publish(forward, { label: spec.label });
    const askpass = spec.askpass ?? null;
    askpass?.onKeyInstall?.((outcome) => deps.onKeyInstall?.(spec.label, outcome));
    try {
      await runStep(forward, spec, mux.ensureArgs, askpass);
      // 登上了(或本来就连着):这次答密码时勾了「下次免密」就去装钥匙。
      askpass?.authenticated?.();
    } finally {
      // 只有「确保连接在」这一步会问人;问完就收掉(结果回执照样会来,见 createTerminalAskpass)。
      closeAskpass(forward);
    }
    await runStep(forward, spec, mux.forwardArgs, null);
    forward.cancel = { command: spec.command, args: mux.cancelArgs };
    const startedAt = now();
    for (;;) {
      if (await deps.canConnect(localPort)) return localPort;
      if (now() - startedAt > readyTimeoutMs) throw new PortForwardError('timeout');
      await sleep(pollMs);
    }
  }

  function closeAskpass(forward: Forward): void {
    const askpass = forward.askpass;
    forward.askpass = null;
    if (askpass) {
      askpass.cancelAll();
      void askpass.close().catch(() => undefined);
    }
  }

  function stop(forward: Forward): void {
    const child = forward.child;
    forward.child = null;
    closeAskpass(forward);
    // 骑在共享连接上的:让共享连接撤掉这一条(连接本身留着给终端、文件用)。
    const cancel = forward.cancel;
    forward.cancel = null;
    if (cancel) {
      try {
        const canceller = deps.spawn(cancel.command, cancel.args, deps.env ?? {});
        canceller.onExit(() => undefined);
      } catch {
        // 共享连接已经没了:转发随它一起没了
      }
    }
    try {
      child?.kill();
    } catch {
      // 已经没了
    }
  }

  async function establish(forward: Forward, sessionId: string, exact: boolean): Promise<number> {
    publish(forward, { phase: 'connecting', localPort: null, prompt: null, reason: null });
    let localPort: number;
    if (exact) {
      // 登录回跳:网址里写死了 localhost:<端口>,只能同号;这台电脑上同号被占就不转(❌ 换号 —— 回跳会落到占着它的那个程序)。
      if (!(await deps.isPortFree(forward.remotePort))) {
        publish(forward, { phase: 'failed', reason: 'local-port-busy', prompt: null, localPort: null });
        throw new PortForwardError('local-port-busy');
      }
      localPort = forward.remotePort;
    } else {
      localPort = await pickLocalPort(forward);
    }
    try {
      try {
        localPort = await dial(forward, sessionId, localPort);
      } catch (error) {
        // 探测完到 ssh 绑上之间端口被别人抢了:换一个系统给的空闲端口,只重试这一次。
        if (!(error instanceof PortForwardError) || error.message !== 'bind-failed' || exact) throw error;
        stop(forward);
        localPort = await dial(forward, sessionId, await systemFreePort());
      }
    } catch (error) {
      stop(forward);
      const reason = error instanceof PortForwardError ? error.reason : 'unknown';
      publish(forward, { phase: 'failed', reason, prompt: null, localPort: null });
      throw error instanceof PortForwardError ? error : new PortForwardError('unknown', String(error));
    }
    forward.lastLocalPort = localPort;
    publish(forward, { phase: 'ready', localPort, prompt: null, reason: null });
    return localPort;
  }

  return {
    /**
     * 持有者 `holder` 要用那台机器的 `remotePort`:已经转好就直接给本机端口,正在转就一起等,没有就转一条。
     * 人在提问卡片上取消 / 认证没过 / 那台机器不许转 ⇒ 抛 PortForwardError(reason 给渲染层写人话)。
     */
    async open(input: {
      deviceId: string;
      sessionId: string;
      remotePort: number;
      holder: string;
      /** 本机端口必须与远端同号(登录回跳这类网址里写死了端口的)。 */
      exactLocalPort?: boolean;
    }): Promise<number> {
      const key = remotePortKey(input.deviceId, input.remotePort);
      let forward = forwards.get(key);
      if (!forward) {
        forward = {
          key,
          deviceId: input.deviceId,
          remotePort: input.remotePort,
          holders: new Set(),
          link: {
            deviceId: input.deviceId,
            remotePort: input.remotePort,
            phase: 'connecting',
            localPort: null,
            prompt: null,
            reason: null,
            label: '',
          },
          child: null,
          askpass: null,
          opening: null,
          lastLocalPort: null,
          cancel: null,
        };
        forwards.set(key, forward);
      }
      forward.holders.add(input.holder);
      const current = forward;
      if (current.link.phase === 'ready' && current.link.localPort && !current.opening) {
        // 单开连接的:进程还在就是还转着。骑共享连接的:没有进程可看,本机端口还能连上才算(共享连接断了转发也没了)。
        const alive = current.child !== null || (current.cancel !== null && (await deps.canConnect(current.link.localPort)));
        if (alive) {
          if (input.exactLocalPort && current.link.localPort !== input.remotePort) throw new PortForwardError('local-port-busy');
          return current.link.localPort;
        }
        if (current.cancel) {
          current.cancel = null;
          publish(current, { phase: 'closed', localPort: null, prompt: null });
        }
      }
      if (!current.opening) {
        current.opening = establish(current, input.sessionId, input.exactLocalPort === true).finally(() => {
          current.opening = null;
        });
      }
      return current.opening;
    },

    /** 持有者不用了(浏览器页签关了)。最后一个放手就撤掉这条转发。 */
    release(input: { deviceId: string; remotePort: number; holder: string }): void {
      const key = remotePortKey(input.deviceId, input.remotePort);
      const forward = forwards.get(key);
      if (!forward) return;
      forward.holders.delete(input.holder);
      if (forward.holders.size > 0) return;
      forwards.delete(key);
      stop(forward);
      publish(forward, { phase: 'closed', localPort: null, prompt: null });
    },

    /** 人在提问卡片上回答了(value = null 是取消)。 */
    answerPrompt(input: { deviceId: string; remotePort: number; promptId: string; value: string | null; installKey?: boolean }): boolean {
      const forward = forwards.get(remotePortKey(input.deviceId, input.remotePort));
      return forward?.askpass?.answer(input.promptId, input.value, { installKey: input.installKey === true }) ?? false;
    },

    status(deviceId: string, remotePort: number): RemotePortLink | null {
      return forwards.get(remotePortKey(deviceId, remotePort))?.link ?? null;
    },

    /**
     * #6264 这台机器此刻转着的端口(「端口」页签那张表,照 VS Code 的 Ports 视图)。
     * holders 只报谁在用(浏览器页签 / 登录回调 / 人手动转的),❌ 报内部 id。
     */
    list(deviceId: string): Array<RemotePortLink & { holders: string[] }> {
      return [...forwards.values()]
        .filter((forward) => forward.deviceId === deviceId)
        .map((forward) => ({ ...forward.link, holders: [...forward.holders] }))
        .sort((a, b) => a.remotePort - b.remotePort);
    },

    /** 人在「端口」页签点了「停止转发」:不管谁还拿着,撤掉(照 VS Code Stop Forwarding Port)。页签下次加载会再要一次。 */
    stop(deviceId: string, remotePort: number): boolean {
      const key = remotePortKey(deviceId, remotePort);
      const forward = forwards.get(key);
      if (!forward) return false;
      forwards.delete(key);
      stop(forward);
      publish(forward, { phase: 'closed', localPort: null, prompt: null });
      return true;
    },

    /** 一个持有者走了(浏览器页签关掉):它拿着的每一条都放手(它在页面里顺带要过的别的端口也算)。 */
    releaseHolder(holder: string): void {
      for (const forward of [...forwards.values()]) {
        if (!forward.holders.delete(holder) || forward.holders.size > 0) continue;
        forwards.delete(forward.key);
        stop(forward);
        publish(forward, { phase: 'closed', localPort: null, prompt: null });
      }
    },

    /** 这台电脑上的某个端口是不是这台机器某条转发的本机那一头(活着的,或上次用过的);是 ⇒ 远端端口。 */
    remoteForLocal(deviceId: string, localPort: number): number | null {
      for (const forward of forwards.values()) {
        if (forward.deviceId !== deviceId) continue;
        if (forward.link.localPort === localPort || forward.lastLocalPort === localPort) return forward.remotePort;
      }
      return null;
    },

    /** 应用退出:所有 ssh 进程一并收掉。 */
    closeAll(): void {
      for (const forward of forwards.values()) stop(forward);
      forwards.clear();
    },

    /** 测试钩子。 */
    size(): number {
      return forwards.size;
    },
  };
}

export type PortForwards = ReturnType<typeof createPortForwards>;
