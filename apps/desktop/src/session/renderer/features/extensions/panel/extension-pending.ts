import type { SessionTranslate } from '../extension-consent';

/**
 * What the extensions screen is doing to one extension right now. Every action
 * there is an IPC round trip, and between the click and the result the row,
 * card or sheet it belongs to must say so and take no second click — an install
 * that can be submitted twice, or an uninstall whose row still offers its
 * switches, is a defect in the state machine, not a polish item (#5265
 * state-change review). One value, one label, drawn the same in all three places.
 */
export type ExtensionPendingAction = 'inspecting' | 'downloading' | 'installing' | 'uninstalling';

/**
 * `percent` is only meaningful while `pending === 'downloading'` — it comes from
 * `marketDownloadProgressChannel`, keyed separately by extension id because the
 * pending action itself carries no payload (#5410). Absent while the first bytes
 * have not arrived yet, so the label still reads as "reading…" for a moment.
 */
export function pendingLabel(
  pending: ExtensionPendingAction,
  translate: SessionTranslate,
  percent?: number
): string {
  if (pending === 'downloading') {
    return percent === undefined
      ? translate('extensions.inspecting')
      : translate('extensions.downloading', { percent });
  }
  return translate(
    pending === 'uninstalling'
      ? 'extensions.uninstalling'
      : pending === 'installing'
        ? 'extensions.installing'
        : 'extensions.inspecting'
  );
}
