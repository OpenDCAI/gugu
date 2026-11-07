/** Keep the pin surface in the conversation frame, including asymmetric scrollbar gutters. */
export function syncContentColumnGeometry(
  probe: HTMLElement | undefined, scroller: HTMLElement | undefined, root: HTMLElement | undefined,
  publishWidth: (width: number) => void,
): void {
  if (!probe) return;
  const column = probe.getBoundingClientRect();
  if (column.width <= 0) return;
  publishWidth(column.width);
  if (!scroller || !root) return;
  const frame = scroller.getBoundingClientRect();
  root.style.setProperty('--chat-pin-frame-left', `${frame.left - column.left}px`);
  root.style.setProperty('--chat-pin-frame-width', `${frame.width}px`);
}
