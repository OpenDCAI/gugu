// #6264 别的机器上新起的服务:从会话输出里认出 `localhost:5173` 这类端口(照 VS Code
// `remote.autoForwardPortsSource: "output"`),交给这台电脑的端口表(rpc.remotePorts.detect)。
// 输出经那台机器的连接送到这台电脑的渲染层,所以扫在这里;本机的会话不扫(本机的 localhost 本来就能开)。
// 只给有浏览器格的机器(用 SSH 装上的):没有浏览器格,认出来了也开不了。
// 成本:每段终端输出 / 每轮提交一次正则,只在这台电脑上;❌ 去那台机器上轮询。
// 报之前按进程核实(照 VS Code `autoForwardPortsSource: "hybrid"`):咕咕自己的端口(钩子 / MCP / 模型中转,
// 比如 Claude `/mcp` 里打出来的 127.0.0.1:35979)不是用户的服务,丢掉。每台机器每个端口只核一次(头回见到时);
// 核不了(旧版 server / 不是 Linux / 调用失败)照报。
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { createPortDetector, findLoopbackPorts } from '@shared/remote-port-detect';
import type { SessionTarget } from '@renderer/lib/session-output-observers';

export type PortReport = { deviceId: string; sessionId: string; ports: number[]; source: 'terminal' | 'agent' };

/** 同时记着几条终端的尾巴(一条输出流一个探测器);再多就丢最早的那条。 */
export const MAX_TRACKED_PTYS = 64;
/** 核实过的「机器 × 端口」记几条;再多就丢最早的(丢了下回见到再核一次)。 */
export const MAX_VERIFIED_PORTS = 256;

export function createMachinePortScanner(deps: {
  /** 这个 id(项目 / pty 会话 id)在哪台机器上;null = 本机。 */
  machineOf: (id: string) => string | null;
  /** 那台机器有没有浏览器格(用 SSH 装上的才有)。 */
  hasBrowser: (deviceId: string) => boolean;
  report: (found: PortReport) => void;
  /** 那台机器上咕咕自己的进程在听的端口;null / 抛错 = 核不了。 */
  ownPorts?: (deviceId: string) => Promise<readonly number[] | null>;
}) {
  const detectorsByPtySession = new Map<string, ReturnType<typeof createPortDetector>>();
  /** `机器:端口` → 是不是咕咕自己的。 */
  const verdicts = new Map<string, Promise<boolean>>();

  const report = (found: PortReport): void => {
    const ownPorts = deps.ownPorts;
    if (!ownPorts) return deps.report(found);
    let own: Promise<Set<number>> | null = null;
    const checks = found.ports.map((port) => {
      const key = `${found.deviceId}:${port}`;
      let verdict = verdicts.get(key);
      if (!verdict) {
        // 一批里的新端口共用一次问询。
        own ??= Promise.resolve(found.deviceId).then(ownPorts).then((ports) => new Set(ports ?? []), () => new Set<number>());
        verdict = own.then((set) => set.has(port));
        verdicts.set(key, verdict);
        if (verdicts.size > MAX_VERIFIED_PORTS) verdicts.delete(verdicts.keys().next().value!);
      }
      return verdict;
    });
    void Promise.all(checks).then((flags) => {
      const ports = found.ports.filter((_, index) => !flags[index]);
      if (ports.length > 0) deps.report({ ...found, ports });
    });
  };

  return {
    onPtyOutput(ptySessionId: string, data: string): void {
      const deviceId = deps.machineOf(ptySessionId);
      if (!deviceId || !deps.hasBrowser(deviceId)) return;
      const parsed = parsePtySessionId(ptySessionId);
      if (!parsed) return;
      let detector = detectorsByPtySession.get(ptySessionId);
      if (!detector) {
        if (detectorsByPtySession.size >= MAX_TRACKED_PTYS) detectorsByPtySession.delete(detectorsByPtySession.keys().next().value!);
        detectorsByPtySession.set(ptySessionId, (detector = createPortDetector()));
      }
      const ports = detector.push(data);
      if (ports.length > 0) report({ deviceId, sessionId: parsed.leafId, ports, source: 'terminal' });
    },

    onCommittedTurn(target: SessionTarget, turn: unknown): void {
      const deviceId = deps.machineOf(target.projectId);
      if (!deviceId || !deps.hasBrowser(deviceId)) return;
      let text: string;
      try {
        text = JSON.stringify(turn);
      } catch {
        return;
      }
      const ports = findLoopbackPorts(text);
      if (ports.length > 0) report({ deviceId, sessionId: target.sessionId, ports, source: 'agent' });
    },
  };
}
