// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModalApi } from './modal';
import type { GuguHost } from './host';

function setup() {
  let closed: (event: { id: string; result: unknown; error?: string }) => void = () => undefined;
  let focus: (edge: 'first' | 'last') => void = () => undefined;
  const raw = {
    modal: { open: vi.fn(async (_args: Record<string, unknown>) => undefined), close: vi.fn(async () => undefined), key: vi.fn(async () => undefined) },
    onModalClosed: (fn: typeof closed) => { closed = fn; return () => undefined; },
    onModalFocus: (fn: typeof focus) => { focus = fn; return () => undefined; },
    reportError: vi.fn(async () => undefined),
  };
  return { api: createModalApi(raw as unknown as GuguHost), raw, closed: (event: Parameters<typeof closed>[0]) => closed(event), focus: (edge: 'first' | 'last') => focus(edge) };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('App modal runtime', () => {
  it('waits for the modal result and restores the opener control', async () => {
    const { api, raw, closed } = setup();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const input = document.createElement('input');
    document.body.append(input); input.focus();
    const result = api.open({ entry: 'new.html', title: 'New', data: { column: 'todo' } });
    const button = document.createElement('button'); document.body.append(button); button.focus();
    const request = raw.modal.open.mock.calls[0]![0];
    expect(request.data).toEqual({ column: 'todo' });
    closed({ id: 'another', result: 'wrong' });
    closed({ id: request.id as string, result: { card: 'a' } });
    await expect(result).resolves.toEqual({ card: 'a' });
    expect(document.activeElement).toBe(input);
    expect('key' in api).toBe(false);
  });

  it('returns null for cancellation and rejects an opening failure', async () => {
    const { api, raw, closed } = setup();
    const result = api.open({ entry: 'new.html', title: 'New' });
    closed({ id: raw.modal.open.mock.calls[0]![0].id as string, result: null });
    await expect(result).resolves.toBeNull();
    raw.modal.open.mockRejectedValueOnce(Object.assign(new Error('Missing page'), { code: 'not-found' }));
    await expect(api.open({ entry: 'missing.html', title: 'New' })).rejects.toThrow('Missing page');
  });

  it('hands only Tab boundaries and unconsumed Escape from a modal guest to its host', async () => {
    const { raw, focus } = setup();
    const first = document.createElement('input'); const last = document.createElement('button');
    for (const el of [first, last]) { Object.defineProperty(el, 'getClientRects', { value: () => [new DOMRect(0, 0, 10, 10)] }); document.body.append(el); }
    focus('first'); document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(raw.modal.key).not.toHaveBeenCalled();
    last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(raw.modal.key).toHaveBeenCalledWith('tab');
    focus('last'); expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    expect(raw.modal.close).not.toHaveBeenCalled();
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); consumed.preventDefault(); last.dispatchEvent(consumed);
    expect(raw.modal.close).not.toHaveBeenCalled();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(raw.modal.close).toHaveBeenCalledOnce();
    raw.modal.key.mockClear();
    const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.tabIndex = 1;
    Object.defineProperty(editor, 'getClientRects', { value: () => [new DOMRect(0, 0, 10, 10)] });
    first.tabIndex = 2; document.body.append(editor);
    focus('first'); expect(document.activeElement).toBe(editor);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(raw.modal.key).toHaveBeenCalledOnce();
    focus('last'); expect(document.activeElement).toBe(last);
  });
});
