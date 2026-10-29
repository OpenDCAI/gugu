import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProjectionHost } from '../../../app-runtime/projection-source';
import type { ProjectionHostPacket, ProjectionViewerPacket } from '@shared/extensions/projection-protocol';
import { mountProjection } from '../../../app-runtime/projection-view';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); });
async function setup() {
  let hear: (watchId: string, packet: ProjectionHostPacket) => void = () => {};
  let watchId = '';
  const packets: ProjectionViewerPacket[] = [];
  let rejectInput = false;
  let refuseInput = false;
  let watches = 0;
  let inputGate: Promise<void> | undefined;
  const host: ProjectionHost = {
    projection: {
      create: vi.fn(), publish: vi.fn(), close: vi.fn(), closed: vi.fn(), inputResult: vi.fn(),
      watch: async args => { watchId = args.watchId; watches++; }, unwatch: async () => {},
      send: async args => {
        packets.push(args.packet);
        if (args.packet.type === 'input') await inputGate;
        if (rejectInput && args.packet.type === 'input') throw new Error('Native input unavailable');
        if (refuseInput && args.packet.type === 'input') return { status: 'rejected' as const, reason: 'Geometry changed' };
      },
    },
    onProjection: callback => { hear = callback; return () => {}; },
  };
  const root = document.createElement('div');
  root.style.cssText = 'width:400px;height:400px';
  document.body.append(root);
  const states: string[] = [];
  const view = await mountProjection(host, root, 'source', { state: state => states.push(state) });
  close = view.close;
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 480;
  canvas.getContext('2d')!.fillRect(0, 0, 640, 480);
  const emit = (packet: ProjectionHostPacket) => hear(watchId, packet);
  let nextGeneration = 0;
  const paint = async () => {
    const generation = String.fromCharCode(97 + nextGeneration++);
    const acks = packets.filter(packet => packet.type === 'ack').length;
    emit({ type: 'state', generation, state: 'connecting' });
    emit({ type: 'frame', generation, frame: { sequence: 1, width: 640, height: 480, mime: 'image/png', data: canvas.toDataURL().split(',')[1]! } });
    await vi.waitFor(() => expect(packets.filter(packet => packet.type === 'ack')).toHaveLength(acks + 1));
  };
  return { root, packets, states, emit, paint, view, watches: () => watches,
    holdInputs: () => { const gate = Promise.withResolvers<void>(); inputGate = gate.promise; return gate.resolve; },
    refuseInput: (value: boolean) => { refuseInput = value; }, rejectInput: (value = true) => { rejectInput = value; }, input: root.querySelector('textarea')! };
}

describe('shared projection surface in Chromium', () => {
  it('stops automatic recapture after a bounded number of consecutive decoding failures', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('Corrupt captured image'));
    let hear: (watch: string, packet: ProjectionHostPacket) => void = () => {};
    let watches = 0;
    const errors = vi.fn();
    const host: ProjectionHost = {
      projection: { create: vi.fn(), publish: vi.fn(), close: vi.fn(), closed: vi.fn(), inputResult: vi.fn(), send: vi.fn(), unwatch: vi.fn(),
        watch: async ({ watchId }) => {
          const generation = String(++watches);
          // Keep the old broken implementation finite so the assertion, not a timeout, fails.
          if (watches <= 10) setTimeout(() => {
            hear(watchId, { type: 'state', state: 'connecting', generation });
            hear(watchId, { type: 'frame', generation, frame: { sequence: 1, width: 1, height: 1, mime: 'image/png', data: 'YQ==' } });
          }, 0);
        },
      }, onProjection: callback => { hear = callback; return () => {}; },
    };
    const root = document.createElement('div'); document.body.append(root);
    const view = await mountProjection(host, root, 'broken', { error: errors }); close = view.close;
    await vi.waitFor(() => expect(errors.mock.calls.length).toBeGreaterThanOrEqual(4));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(watches).toBeLessThanOrEqual(4);
    expect(root.querySelector('textarea')!.disabled).toBe(true);
  });

  it('paints before ACK, maps the real letterboxed image, and disables input on disconnect', async () => {
    const s = await setup();
    expect(s.input.disabled).toBe(true);
    expect(s.packets).toEqual([]);
    await s.paint();
    expect(s.packets[0]).toMatchObject({ type: 'ack', frame: 1 });
    await page.elementLocator(s.root.querySelector('img')!).click({ position: { x: 200, y: 200 } });
    for (const action of ['down', 'up']) {
      const pointer = s.packets.find(p => p.type === 'input' && p.input.kind === 'pointer' && p.input.action === action);
      if (pointer?.type !== 'input' || pointer.input.kind !== 'pointer') throw new Error(`No ${action}`);
      expect(pointer.input.x).toBeCloseTo(0.5, 4);
      expect(pointer.input.y).toBeCloseTo(0.5, 4);
    }
    await page.elementLocator(s.root.querySelector('img')!).click({ position: { x: 100, y: 100 } });
    const offCenter = s.packets.findLast(p => p.type === 'input' && p.input.kind === 'pointer' && p.input.action === 'down');
    if (offCenter?.type !== 'input' || offCenter.input.kind !== 'pointer') throw new Error('No off-center click');
    expect(offCenter.input.x).toBeCloseTo(0.25, 4);
    expect(offCenter.input.y).toBeCloseTo(1 / 6, 4);
    s.emit({ type: 'state', generation: 'a', state: 'closed' });
    expect(s.input.disabled).toBe(true);
    const count = s.packets.length;
    s.input.value = 'late';
    s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'late' }));
    expect(s.packets).toHaveLength(count);
  });

  it('commits IME and paste once, without forwarding the local paste shortcut', async () => {
    const s = await setup();
    await s.paint();
    s.input.dispatchEvent(new CompositionEvent('compositionstart'));
    s.input.value = '中文';
    s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '中文', isComposing: true }));
    s.input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文' }));
    // A browser may deliver the final input after compositionend, with the same committed value.
    s.input.value = '中文';
    s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertFromComposition', data: '中文' }));
    s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', '粘贴\n第二行');
    s.input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, cancelable: true }));
    s.input.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', ctrlKey: true }));
    await vi.waitFor(() => expect(s.packets.filter(p => p.type === 'input')).toHaveLength(2));
    const inputs = s.packets.filter(p => p.type === 'input').map(p => p.input);
    expect(inputs).toEqual([{ kind: 'text', text: '中文', source: 'ime' }, { kind: 'text', text: '粘贴\n第二行', source: 'paste' }]);
    expect(s.input.value).toBe('');
  });

  it('focus loss replaces the input generation and requires a fresh picture', async () => {
    const s = await setup();
    await s.paint();
    s.input.focus();
    s.input.blur();
    expect(s.watches()).toBe(2);
    expect(s.input.disabled).toBe(true);
    s.emit({ type: 'frame', generation: 'a', frame: { sequence: 2, width: 1, height: 1, mime: 'image/png', data: 'YQ==' } });
    expect(s.input.disabled).toBe(true);
    await s.paint();
    expect(s.input.disabled).toBe(false);
  });

  it('retains unconfirmed text without replay and accepts new input after a fresh generation', async () => {
    const s = await setup();
    await s.paint();
    s.rejectInput();
    s.input.value = '不能丢的草稿';
    s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: s.input.value }));
    await vi.waitFor(() => expect(s.states).toContain('input-paused'));
    expect(s.view.pendingText()).toEqual([expect.objectContaining({ text: '不能丢的草稿', state: 'unconfirmed' })]);
    expect(s.input.disabled).toBe(true);
    await s.paint();
    expect(s.input.disabled).toBe(false);
    expect(s.states.at(-1)).toBe('live');
    expect(s.packets.filter(p => p.type === 'input')).toHaveLength(1);
    expect(s.view.pendingText()).toEqual([expect.objectContaining({ text: '不能丢的草稿', state: 'unconfirmed' })]);
    s.rejectInput(false);
    s.input.value = '新输入';
    s.input.dispatchEvent(new InputEvent('input'));
    await vi.waitFor(() => expect(s.packets.filter(p => p.type === 'input')).toHaveLength(2));
    s.view.discardPendingText(s.view.pendingText()[0]!.id);
    await vi.waitFor(() => expect(s.view.pendingText()).toEqual([]));
  });
  it('rejects only the oversized or refused input and preserves text explicitly as not sent', async () => {
    const s = await setup(); await s.paint();
    s.input.value = 'x'.repeat(64 * 1024 + 1); s.input.dispatchEvent(new InputEvent('input'));
    await vi.waitFor(() => expect(s.view.pendingText()[0]?.state).toBe('not-sent'));
    expect(s.input.disabled).toBe(false);
    expect(s.packets.filter(p => p.type === 'input')).toHaveLength(0);
    s.view.discardPendingText(s.view.pendingText()[0]!.id);
    s.refuseInput(true); s.input.value = 'refused'; s.input.dispatchEvent(new InputEvent('input'));
    await vi.waitFor(() => expect(s.view.pendingText()[0]?.state).toBe('not-sent'));
    expect(s.input.disabled).toBe(false);
    s.refuseInput(false); s.input.value = 'valid'; s.input.dispatchEvent(new InputEvent('input'));
    await vi.waitFor(() => expect(s.packets.filter(p => p.type === 'input')).toHaveLength(2));
    await vi.waitFor(() => expect(s.view.pendingText()).toEqual([expect.objectContaining({ text: 'refused', state: 'not-sent' })]));
  });

  it('lets AltGr commit its printable text without a Ctrl+Alt shortcut', async () => {
    const s = await setup(); await s.paint();
    const key = new KeyboardEvent('keydown', { key: '€', ctrlKey: true, altKey: true, modifierAltGraph: true, cancelable: true });
    s.input.dispatchEvent(key); expect(key.defaultPrevented).toBe(false);
    s.input.value = '€'; s.input.dispatchEvent(new InputEvent('input', { data: '€' }));
    s.input.dispatchEvent(new KeyboardEvent('keyup', { key: '€', ctrlKey: true, altKey: true, modifierAltGraph: true }));
    await vi.waitFor(() => expect(s.packets.filter(p => p.type === 'input')).toHaveLength(1));
    expect(s.packets.filter(p => p.type === 'input').map(p => p.input)).toEqual([{ kind: 'text', text: '€', source: 'typing' }]);
  });

  it('keeps an explicitly discarded unconfirmed record cleared when its late outcome arrives', async () => {
    const s = await setup(); await s.paint(); const finish = s.holdInputs(); s.rejectInput();
    s.input.value = 'discard this record'; s.input.dispatchEvent(new InputEvent('input'));
    await vi.waitFor(() => expect(s.view.pendingText()[0]?.state).toBe('unconfirmed'));
    s.view.discardPendingText(s.view.pendingText()[0]!.id); finish();
    await vi.waitFor(() => expect(s.states).toContain('input-paused'));
    expect(s.view.pendingText()).toEqual([]);
    await s.paint(); expect(s.packets.filter(p => p.type === 'input')).toHaveLength(1);
  });

});
