import type { ProjectionFrame, ProjectionInput } from '@shared/extensions/projection-protocol';
import { ProjectionInputNotSent } from './projection-input-queue';
import { projectionClient } from './projection-client';
import type { ProjectionHost } from './projection-source';
export type PendingProjectionText = { id: number; text: string; state: 'not-sent' | 'unconfirmed'; reason?: string };
export type ProjectionViewState = 'connecting' | 'live' | 'input-paused' | 'closed';

/** The shared picture/input surface. Its App owns surrounding chrome, target selection, and driver code. */
export async function mountProjection(host: ProjectionHost, root: HTMLElement, id: string, options: {
  state?(state: ProjectionViewState, reason?: string): void; error?(error: unknown): void;
} = {}) {
  const surface = document.createElement('div');
  surface.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;touch-action:none';
  const image = document.createElement('img');
  image.alt = '';
  image.draggable = false;
  image.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;user-select:none';
  // A focus proxy lets the platform IME commit text normally, with no second input form.
  const input = document.createElement('textarea');
  input.setAttribute('aria-label', 'Input');
  input.autocomplete = 'off';
  input.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;resize:none';
  surface.append(image, input);
  root.append(surface);
  let frame: ProjectionFrame | null = null;
  let ready = false;
  let nextText = 0;
  const observed = new WeakSet<Promise<unknown>>();
  const pendingText = new Map<number, PendingProjectionText>();
  let composing = false;
  let committed: string | null = null;
  let button: 'left' | 'middle' | 'right' = 'left';
  let client: Awaited<ReturnType<typeof projectionClient>> | undefined;
  const lifetime = new AbortController();
  const pause = (error: unknown) => {
    ready = false;
    input.disabled = true;
    options.state?.('input-paused');
    options.error?.(error);
    void client?.reset().catch(options.error);
  };
  const reset = () => { if (ready) void client?.reset().catch(pause); };
  input.addEventListener('blur', reset);
  window.addEventListener('blur', reset, { signal: lifetime.signal });
  const send = (value: ProjectionInput) => {
    const text = value.kind === 'text' ? { id: ++nextText, text: value.text, state: 'not-sent' as const } : undefined;
    if (text) pendingText.set(text.id, text);
    if (!ready || !client) return;
    const operation = client.input(value, () => { if (text && pendingText.has(text.id)) pendingText.set(text.id, { ...text, state: 'unconfirmed' }); });
    if (observed.has(operation)) return;
    observed.add(operation);
    void operation.then(result => {
      if (result.status === 'applied') { if (text) pendingText.delete(text.id); return; }
      if (text && pendingText.has(text.id)) pendingText.set(text.id, { ...text, state: result.status === 'rejected' ? 'not-sent' : 'unconfirmed', reason: result.reason });
      if (result.status === 'unknown') pause(new Error(result.reason));
      else options.error?.(new Error(result.reason));
    }, error => {
      if (text && pendingText.has(text.id)) pendingText.set(text.id, { ...text, reason: String(error) });
      if (error instanceof ProjectionInputNotSent) options.error?.(error);
      else pause(error);
    });
  };
  const modifiers = (event: MouseEvent | KeyboardEvent) => [
    ...(event.altKey ? ['alt' as const] : []), ...(event.ctrlKey ? ['control' as const] : []),
    ...(event.metaKey ? ['meta' as const] : []), ...(event.shiftKey ? ['shift' as const] : []),
  ];
  const point = (event: MouseEvent, clamp = false) => {
    if (!frame || !ready) return null;
    const box = image.getBoundingClientRect();
    const ratio = (image.naturalWidth || frame.width) / (image.naturalHeight || frame.height);
    const width = Math.min(box.width, box.height * ratio);
    const height = width / ratio;
    if (width <= 0 || height <= 0) return null;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width;
    const y = (event.clientY - box.top - (box.height - height) / 2) / height;
    if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  };
  surface.addEventListener('pointerdown', event => {
    const at = point(event);
    if (!at || event.button > 2) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    button = event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left';
    surface.setPointerCapture(event.pointerId);
    send({ kind: 'pointer', action: 'down', button, ...at, modifiers: modifiers(event) });
  });
  surface.addEventListener('pointermove', event => {
    const at = point(event, surface.hasPointerCapture(event.pointerId));
    if (at) send({ kind: 'pointer', action: 'move', button, ...at, modifiers: modifiers(event) });
  });
  surface.addEventListener('pointerup', event => {
    const at = point(event, true);
    if (at) send({ kind: 'pointer', action: 'up', button, ...at, modifiers: modifiers(event) });
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  });
  surface.addEventListener('pointercancel', event => {
    const at = point(event, true);
    if (at) send({ kind: 'pointer', action: 'up', button, ...at, modifiers: modifiers(event) });
  });
  surface.addEventListener('contextmenu', event => event.preventDefault());
  surface.addEventListener('wheel', event => {
    const at = point(event);
    if (!at) return;
    event.preventDefault();
    send({ kind: 'wheel', ...at, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
  }, { passive: false });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    committed = input.value;
    if (committed) send({ kind: 'text', text: committed, source: 'ime' });
    input.value = '';
    setTimeout(() => { committed = null; }, 0);
  });
  input.addEventListener('input', () => {
    if (composing) return;
    if (committed && input.value === committed) { committed = null; input.value = ''; return; }
    if (input.value) send({ kind: 'text', text: input.value, source: 'typing' });
    input.value = '';
  });
  input.addEventListener('paste', event => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) send({ kind: 'text', text, source: 'paste' });
    input.value = '';
  });
  for (const [eventName, action] of [['keydown', 'down'], ['keyup', 'up']] as const) {
    input.addEventListener(eventName, event => {
      if (event.isComposing || composing || event.key === 'Process' || event.key === 'Dead' || event.getModifierState('AltGraph')) return;
      // The local paste event carries the committed text; forwarding the shortcut would paste it twice.
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') || (event.shiftKey && event.key === 'Insert')) return;
      // Printable characters come from input/composition, so Chinese input and paste are never typed twice.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      event.preventDefault();
      send({ kind: 'key', action, key: event.key, modifiers: modifiers(event) });
    });
  }
  try {
    client = await projectionClient(host, id, {
      paint: async next => {
        image.src = `data:${next.mime};base64,${next.data}`;
        await image.decode();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        frame = next;
      },
      state: (state, reason) => {
        ready = state === 'live';
        input.disabled = !ready;
        options.state?.(state, reason);
      },
      error: pause,
    });
  } catch (error) { lifetime.abort(); surface.remove(); throw error; }
  return Object.freeze({ pendingText: () => [...pendingText.values()].map(entry => ({ ...entry })), discardPendingText: (id: number) => pendingText.delete(id), close: async () => {
    lifetime.abort();
    try { await client?.close(); }
    finally { surface.remove(); }
  } });
}
