// 会话页里的「报障」只有一条出路:转达给壳,由壳打开它已有的问题反馈(侧栏那一个)。
//
// ⚠️ 这里从前是会话页**自己的**反馈弹窗,提交时把正文、联系方式、诊断日志和附件直接
// POST 到一条写死在源码里的外部 Discord webhook —— 那不是咕咕的收件箱。
// 咕咕的问题反馈按 product spec 落库并判重转 GitHub issue,报障只该有这一个目的地。
import { findSessionShellPort, isSessionShellUnsupported } from '@renderer/lib/shell-port';
import { log } from '@renderer/utils/logger';

export function openShellFeedback(): void {
  const shell = findSessionShellPort();
  if (!shell) return;
  void shell.openFeedback().catch((error: unknown) => {
    // 「这个形态的壳不提供」是已知状态,不是故障 —— 见 shell-port 的 SessionShellUnsupportedError。
    if (!isSessionShellUnsupported(error)) log.error('打开问题反馈失败', error);
  });
}
