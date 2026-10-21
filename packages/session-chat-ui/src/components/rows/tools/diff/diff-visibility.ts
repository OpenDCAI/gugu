import type { ChatDiff } from '@session-chat/model';

/**
 * Providers can stream a proposed diff before ACP permission is answered.
 * Until the request is resolved, expose only the operation name and pending
 * state; showing line counts or body text would claim that the file changed.
 */
export function diffBodyVisible(item: Pick<ChatDiff, 'awaitingPermission'>): boolean {
  return !item.awaitingPermission;
}
