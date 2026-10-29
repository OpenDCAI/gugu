import { describe, expect, it } from 'vitest';
import { projectionFrame, projectionInput, projectionViewerPacket, PROJECTION_FRAME_BYTES } from './projection-protocol';

describe('projection wire validation', () => {
  const frame = { sequence: 1, width: 640, height: 480, mime: 'image/png', data: 'YQ==' };
  it('bounds frame payload and source coordinate space, without retaining mutable caller objects', () => {
    const admitted = projectionFrame(frame);
    expect(admitted).toEqual(frame);
    expect(admitted).not.toBe(frame);
    for (const change of [
      { sequence: 0 }, { sequence: Infinity }, { width: 0 }, { height: 8193 }, { width: 8192, height: 8192 },
      { data: 'a' }, { data: 'a===' }, { data: 'a=aa' }, { data: '!!!!' }, { mime: 'text/html' },
      { data: 'YWFh'.repeat(Math.ceil(PROJECTION_FRAME_BYTES / 3) + 1) },
    ]) expect(() => projectionFrame({ ...frame, ...change })).toThrow(/Invalid/);
  });
  it('snapshots normalized pointers and rejects coercion, non-finite coordinates, and invented modifiers', () => {
    const input = { kind: 'pointer', action: 'down', button: 'left', x: 0.5, y: 1, modifiers: ['shift'] };
    const admitted = projectionInput(input);
    input.modifiers.length = 0;
    expect(admitted).toMatchObject({ modifiers: ['shift'] });
    for (const change of [{ x: -1 }, { y: NaN }, { x: '0.5' }, { button: 'back' }, { action: { toString: () => 'down' } }, { modifiers: ['super'] }]) {
      expect(() => projectionInput({ ...input, ...change })).toThrow(/Invalid/);
    }
  });
  it('accepts committed Chinese/paste text as one event and validates wheel/key fields', () => {
    expect(projectionInput({ kind: 'text', text: '中文\n粘贴' })).toEqual({ kind: 'text', text: '中文\n粘贴' });
    expect(projectionInput({ kind: 'wheel', x: 0, y: 1, deltaX: 1, deltaY: -2 })).toMatchObject({ deltaY: -2 });
    expect(() => projectionInput({ kind: 'wheel', x: 0, y: 1, deltaX: 0, deltaY: Infinity })).toThrow();
    expect(() => projectionInput({ kind: 'key', key: '', action: 'up' })).toThrow();
    expect(() => projectionInput({ kind: 'text', text: 'a'.repeat(65_537) })).toThrow();
  });
  it('requires bounded generation and positive frame/input sequences', () => {
    expect(projectionViewerPacket({ type: 'ack', generation: 'g', frame: 1 })).toEqual({ type: 'ack', generation: 'g', frame: 1 });
    for (const raw of [null, [], { type: 'ack', generation: 1, frame: 1 }, { type: 'ack', generation: 'g', frame: 0 },
      { type: 'input', generation: 'g', frame: 1, sequence: -1, input: { kind: 'text', text: 'a' } }]) {
      expect(() => projectionViewerPacket(raw)).toThrow(/Invalid/);
    }
  });
});
