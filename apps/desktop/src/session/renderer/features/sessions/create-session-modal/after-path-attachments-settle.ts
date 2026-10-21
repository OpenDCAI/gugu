import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';

/**
 * #6264 附件贴上来就在传(传到会话要建在的那台机器);点「创建」时还没传完就等它传完再建,
 * 有一件没成就不建 —— 那一件的 chip 上写着为什么、能重试(product spec)。
 * 等的期间 `busy` 为真(再点不重入,发送键显示在忙)。
 */
export function afterPathAttachmentsSettle(
  session: Pick<InitialSessionState, 'pathAttachmentsUnsettled' | 'waitForPathAttachments'>,
  busy: { current: boolean },
  setBusy: (busy: boolean) => void,
  run: () => void
): void {
  if (!session.pathAttachmentsUnsettled()) return run();
  busy.current = true;
  setBusy(true);
  void session.waitForPathAttachments().then((ready) => {
    busy.current = false;
    setBusy(false);
    if (ready) run();
  });
}
