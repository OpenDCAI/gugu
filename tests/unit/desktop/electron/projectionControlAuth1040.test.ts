import { describe, expect, it } from 'vitest';
import { projectionControlKey, projectionControlSigner, verifyProjectionControl } from '../../../../apps/desktop/electron/projection-control-auth';

describe('main-owned projection control signatures', () => {
  it('binds exact bytes to the source and page epoch, without accepting bare or modified packets', () => {
    const key = projectionControlKey(), raw = JSON.stringify({ type: 'input', text: '中文🙂' });
    const signed = projectionControlSigner(key, 'binding', 'source', () => {})(raw);
    expect(verifyProjectionControl(key, 'binding', 'source', signed)).toBe(raw);
    for (const [otherKey, binding, source, packet] of [
      [projectionControlKey(), 'binding', 'source', signed], [key, 'old-epoch', 'source', signed],
      [key, 'binding', 'other-source', signed], [key, 'binding', 'source', signed.replace('中文', '改变')],
      [key, 'binding', 'source', raw], [key, 'binding', 'source', signed.slice(0, -1)],
    ]) expect(() => verifyProjectionControl(otherKey!, binding!, source!, packet!)).toThrow();
  });
  it('rechecks the page before every signature and bounds encoded envelope bytes', () => {
    const controller = new AbortController(), key = projectionControlKey();
    const sign = projectionControlSigner(key, 'page', 'source', () => controller.signal.throwIfAborted());
    expect(() => sign('界'.repeat(5500))).toThrow(/too large/);
    expect(() => sign('"'.repeat(9000))).toThrow(/too large/);
    const valid = sign('ack'); expect(verifyProjectionControl(key, 'page', 'source', valid)).toBe('ack');
    controller.abort(new Error('Page retargeted')); expect(() => sign('ack')).toThrow(/retargeted/);
  });
});
