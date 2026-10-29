import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProjectionHost } from '../../../app-runtime/projection-source';
import type { ProjectionHostPacket, ProjectionViewerPacket } from '@shared/extensions/projection-protocol';
import { mountProjection } from '../../../app-runtime/projection-view';

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });
async function setup() {
  let hear: (watchId: string, packet: ProjectionHostPacket) => void = () => {};
  let watchId = '';
  const packets: ProjectionViewerPacket[] = [];
  let rejectInput = false;
  let watches = 0;
  const host: ProjectionHost = {
    projection: {
      create: vi.fn(), publish: vi.fn(), close: vi.fn(), closed: vi.fn(), inputResult: vi.fn(),
      watch: async args => { watchId = args.watchId; watches++; }, unwatch: async () => {},
      send: async args => {
        packets.push(args.packet);
        if (rejectInput && args.packet.type === 'input') throw new Error('Native input unavailable');
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
    rejectInput: () => { rejectInput = true; }, input: root.querySelector('textarea')! };
}

describe('shared projection surface in Chromium', () => {
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

  it('retains rejected text, pauses input, and never replays it when another picture arrives', async () => {
    const s = await setup();
    await s.paint();
    s.rejectInput();
    s.input.value = '不能丢的草稿';
    s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: s.input.value }));
    await vi.waitFor(() => expect(s.states.at(-1)).toBe('input-paused'));
    expect(s.view.pendingText()).toEqual(['不能丢的草稿']);
    expect(s.input.disabled).toBe(true);
    await s.paint();
    expect(s.states.at(-1)).toBe('input-paused');
    expect(s.packets.filter(p => p.type === 'input')).toHaveLength(1);
    expect(s.view.pendingText()).toEqual(['不能丢的草稿']);
  });
});
