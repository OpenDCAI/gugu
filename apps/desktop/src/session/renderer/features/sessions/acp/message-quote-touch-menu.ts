/** Bubble padding offers the whole-message menu; its text keeps native selection. */
export function bindMessageQuoteTouchMenu(bubble: HTMLElement, text: HTMLElement, open: (at: { x: number; y: number }) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const clear = () => { clearTimeout(timer); timer = undefined; start = null; };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    clear(); fired = false;
    const target = event.target;
    if (!(target instanceof Node) || text.contains(target)
      || (target instanceof Element && target.closest('a,button,input,textarea,[contenteditable],img'))) return;
    const at = { x: event.clientX, y: event.clientY };
    start = at;
    timer = setTimeout(() => {
      clear(); fired = true;
      bubble.ownerDocument.getSelection()?.removeAllRanges();
      open(at);
    }, 500);
  };
  const move = (event: PointerEvent) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 10) clear();
  };
  const context = (event: MouseEvent) => {
    // Android may deliver its contextmenu before our hold timer. Claim a padding
    // hold once; a hold starting in the text still belongs to native selection.
    if (fired) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!start) return;
    const at = start;
    clear(); fired = true;
    event.preventDefault(); event.stopImmediatePropagation();
    bubble.ownerDocument.getSelection()?.removeAllRanges();
    open(at);
  };
  const end = (event: TouchEvent) => { if (fired) { fired = false; event.preventDefault(); } };
  bubble.addEventListener('pointerdown', down);
  bubble.addEventListener('pointermove', move);
  bubble.addEventListener('contextmenu', context, true);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) bubble.addEventListener(type, clear);
  bubble.addEventListener('touchend', end, { passive: false });
  bubble.ownerDocument.addEventListener('scroll', clear, true);
  return () => {
    clear();
    bubble.removeEventListener('pointerdown', down);
    bubble.removeEventListener('pointermove', move);
    bubble.removeEventListener('contextmenu', context, true);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) bubble.removeEventListener(type, clear);
    bubble.removeEventListener('touchend', end);
    bubble.ownerDocument.removeEventListener('scroll', clear, true);
  };
}
