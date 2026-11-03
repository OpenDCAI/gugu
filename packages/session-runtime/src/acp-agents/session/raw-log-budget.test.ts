import { expect, it } from 'vitest';
import { RawAcpLog } from './raw-log';

it('bounds raw trace bytes, reports omissions, and retains recent small events', () => {
  const log = new RawAcpLog(
    { sessionId: 's', providerId: 'fixture', acpSessionId: 'p', createdAt: '' },
    50000,
    1024,
  );
  for (let n = 0; n < 100; n++)
    log.record({ kind: 'session_update', sessionId: 'p', update: { text: 'x'.repeat(128) } });
  log.record({ kind: 'session_update', sessionId: 'p', update: { text: 'x'.repeat(2048) } });
  log.record({ kind: 'prompt_result', sessionId: 'p', stopReason: 'end_turn' });
  const snapshot = log.snapshot();
  expect(snapshot.events.length).toBeLessThan(6);
  expect(snapshot.meta.droppedEvents).toBeGreaterThan(95);
  expect(snapshot.events.at(-1)?.event.kind).toBe('prompt_result');
  expect(
    Buffer.byteLength(JSON.stringify(snapshot.events.map((entry) => entry.event))),
  ).toBeLessThanOrEqual(1024);
});
