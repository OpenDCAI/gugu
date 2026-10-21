/**
 * #6264 终端 / agent 输出里发现的那台机器的端口(照 VS Code `autoForwardPortsSource: "output"`)。
 * 只记在内存里、每台机器有上限(输出里一个测试套件能起一大串临时端口,VS Code #112724 就是被它刷屏)。
 * 发现 ≠ 转发:真要用(浏览器页签打开、页面里请求到它)时才起 SSH 转发,❌ 为没人用的端口常驻一个 ssh 进程。
 */
import type { DetectedRemotePort } from '@shared/remote-ports';

export const MAX_DETECTED_PER_DEVICE = 50;

export function createDetectedPorts(deps: {
  now?: () => number;
  onChanged(deviceId: string): void;
  onDetected(entry: DetectedRemotePort & { deviceId: string }): void;
}) {
  const now = deps.now ?? (() => Date.now());
  const byDevice = new Map<string, Map<number, DetectedRemotePort>>();
  return {
    detect(deviceId: string, sessionId: string, ports: readonly number[], source: DetectedRemotePort['source']): void {
      let table = byDevice.get(deviceId);
      if (!table) byDevice.set(deviceId, (table = new Map()));
      let changed = false;
      for (const remotePort of ports) {
        if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort >= 65536 || table.has(remotePort)) continue;
        const entry = { remotePort, sessionId, source, at: now() };
        table.set(remotePort, entry);
        changed = true;
        while (table.size > MAX_DETECTED_PER_DEVICE) table.delete(table.keys().next().value as number);
        deps.onDetected({ deviceId, ...entry });
      }
      if (changed) deps.onChanged(deviceId);
    },
    list(deviceId: string): DetectedRemotePort[] {
      return [...(byDevice.get(deviceId)?.values() ?? [])].sort((a, b) => a.remotePort - b.remotePort);
    },
    /** 人在「端口」页签里把它从表上拿掉。 */
    forget(deviceId: string, remotePort: number): void {
      if (byDevice.get(deviceId)?.delete(remotePort)) deps.onChanged(deviceId);
    },
  };
}
