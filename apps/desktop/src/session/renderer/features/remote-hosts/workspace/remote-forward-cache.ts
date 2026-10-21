// #6264 这台电脑上每台机器此刻转着的端口:本机端口 → 那台机器上的端口。浏览器页签的地址栏据此把实际加载的
// `127.0.0.1:<本机端口>` 显示回 `localhost:<那台机器上的端口>`(页面里自己跳到别的端口时,转发是主进程替它做的,
// 页签自己手里没有那一条)。按机器订一次,主进程报「端口表变了」时重读(事件驱动,❌ 定时问)。
import { events, rpc } from '@renderer/lib/ipc';
import { remotePortsChangedChannel } from '@shared/remote-ports';

const byDevice = new Map<string, { localToRemote: Map<number, number>; refs: number; off: () => void }>();

function reload(deviceId: string): void {
  void rpc.remotePorts
    .list({ deviceId })
    .then((result) => {
      const entry = byDevice.get(deviceId);
      if (!entry || !result.success) return;
      entry.localToRemote.clear();
      for (const forward of result.data.forwards) {
        if (forward.localPort !== null) entry.localToRemote.set(forward.localPort, forward.remotePort);
      }
    })
    .catch(() => undefined);
}

/** 开始跟这台机器的转发;返回停止。 */
export function watchRemoteForwards(deviceId: string): () => void {
  let entry = byDevice.get(deviceId);
  if (!entry) {
    entry = { localToRemote: new Map(), refs: 0, off: events.on(remotePortsChangedChannel, () => reload(deviceId), deviceId) };
    byDevice.set(deviceId, entry);
    reload(deviceId);
  }
  entry.refs += 1;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const current = byDevice.get(deviceId);
    if (!current || --current.refs > 0) return;
    current.off();
    byDevice.delete(deviceId);
  };
}

export function remoteForLocalPort(deviceId: string, localPort: number): number | null {
  return byDevice.get(deviceId)?.localToRemote.get(localPort) ?? null;
}
