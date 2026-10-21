import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';

/**
 * 把一次按键交给主进程，并且**不丢掉它的判决**。
 *
 * 主进程对每一次写入都给一个 typed 判决（会话不在 → `not_found`；写入抛错 → reject）。这条判决
 * 曾经被终端的两个调用点各自 `void` 掉，于是「会话已经没了」的按键一个字都不响：用户接着打，
 * 产品什么都不说。那正是 #4525 那一族缺陷的形状（fail silent），也是本仓第一条铁律要挡的东西。
 *
 * ❌ 不在这里重试、不排队等会话回来：谁也说不出那时候该重放进哪一个会话。这里只负责让丢失显形。
 */
export function sendTerminalInput(ptySessionId: string, data: string): void {
  void rpc.pty
    .sendInput(ptySessionId, data)
    .then((result) => {
      if (result.success) return;
      reportTerminalInputFailure(ptySessionId, data, JSON.stringify(result.error));
    })
    .catch((error: unknown) => {
      reportTerminalInputFailure(ptySessionId, data, error instanceof Error ? error.message : String(error));
    });
}

function reportTerminalInputFailure(ptySessionId: string, data: string, outcome: string): void {
  log.error('terminal input was not written to its session', {
    ptySessionId,
    // 正文是用户正在打的内容；只报长度和它是不是提交键，❌ 不把击键抄进日志。
    byteLength: data.length,
    wasSubmitKey: data === '\r',
    outcome,
  });
}
