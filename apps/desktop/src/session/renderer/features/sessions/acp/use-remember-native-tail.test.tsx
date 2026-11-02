// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract';

const env = vi.hoisted(() => ({
  deviceId: 'host' as string | null,
  version: 1 as number | undefined,
  unavailable: null as string | null,
  read: vi.fn(), write: vi.fn(), warn: vi.fn(),
}));
vi.mock('@/hooks/useConversationSessionSummary', () => ({ useConversationSessionSummary: () => ({ nativeInputVersion: env.version }) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => env.deviceId } }));
vi.mock('../machine-unavailable-label', () => ({ machineUnavailableLabel: () => env.unavailable }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: (deviceId: string) => ({
  sessionTimeline: { sessionNativeRecord: (input: unknown) => env.read(deviceId, input) },
}) }));
vi.mock('@/mobile/agent-watch/timeline-cache', () => ({ writeCachedNativeRecord: env.write }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: env.warn }) }));
import { rememberNativeTail, useRememberNativeTail } from './use-remember-native-tail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const page = (text = 'last reply'): NativeSessionRecord => ({
  turns: [{ id: 's:turn:s1', seq: 1, initiator: 'user', items: [{ id: 'm', seq: 0, kind: 'message', role: 'assistant', text }] }],
  originTurnIds: ['origin'], nextCursor: null, latestStoredSeq: 1, hasNewer: false, activeTurn: null,
});
const ok = (value = page()) => ({ ok: true as const, value });
let root: Root;
function Probe({ generating = false, shown = true, sessionId = 's' }: { generating?: boolean; shown?: boolean; sessionId?: string }) {
  useRememberNativeTail('p', sessionId, generating, shown);
  return null;
}
const render = async (props: Parameters<typeof Probe>[0] = {}) => {
  await act(async () => { root.render(createElement(Probe, props)); });
};
beforeEach(() => {
  vi.useFakeTimers();
  env.deviceId = 'host'; env.version = 1; env.unavailable = null;
  env.read.mockReset().mockResolvedValue(ok()); env.write.mockReset(); env.warn.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it('writes the host tail once on open, replaces it with the next page, and never polls an idle page', async () => {
  await render();
  expect(env.read.mock.calls).toEqual([['host', { conversationId: 's', tail: true }]]);
  expect(env.write).toHaveBeenCalledWith({ deviceId: 'host', sessionId: 's' }, page());
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(env.read).toHaveBeenCalledTimes(1);
  await render({ generating: true });
  const next = page('new tail'); env.read.mockResolvedValue(ok(next));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
  expect(env.read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(env.write.mock.calls.at(-1)).toEqual([{ deviceId: 'host', sessionId: 's' }, next]);
});

it('coalesces nearby turn endings with the existing 1.5 second debounce', async () => {
  await render({ generating: true }); await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await render({ generating: true }); await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(env.read).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(env.read).toHaveBeenCalledTimes(2);
});

it.each([1, 2])('remembers native version %s', async version => {
  env.version = version; await render(); expect(env.write).toHaveBeenCalledTimes(1);
});

it.each(['local', 'legacy', 'unreachable', 'hidden'])('does not read a %s page', async kind => {
  if (kind === 'local') env.deviceId = null;
  if (kind === 'legacy') env.version = undefined;
  if (kind === 'unreachable') env.unavailable = 'away';
  await render({ shown: kind !== 'hidden' });
  await render({ generating: true, shown: kind !== 'hidden' });
  await render({ shown: kind !== 'hidden' });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(env.read).not.toHaveBeenCalled();
});

it('cancels a scheduled save on leaving and saves the correct identity when another page opens', async () => {
  await render({ generating: true }); await render();
  await render({ shown: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(env.read).toHaveBeenCalledTimes(1);
  await render({ sessionId: 'other' });
  expect(env.read.mock.calls.at(-1)).toEqual(['host', { conversationId: 'other', tail: true }]);
  await render({ generating: true }); await render();
  act(() => root.unmount()); root = createRoot(document.createElement('div'));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(env.read).toHaveBeenCalledTimes(3);
});

it('serializes a session with only one pending save, even across page instances', async () => {
  let resolve!: (value: ReturnType<typeof ok>) => void;
  env.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = rememberNativeTail('host', 's', () => true);
  const second = rememberNativeTail('host', 's', () => true);
  rememberNativeTail('host', 's', () => true);
  expect(env.read).toHaveBeenCalledTimes(1);
  resolve(ok()); await Promise.all([first, second]);
  expect(env.read).toHaveBeenCalledTimes(2);
  expect(env.write).toHaveBeenCalledTimes(2);
});

it('drops a queued save when its page is gone or its host becomes unavailable', async () => {
  let resolve!: (value: ReturnType<typeof ok>) => void;
  env.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render({ generating: true }); await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  env.unavailable = 'away';
  await act(async () => { resolve(ok()); });
  expect(env.read).toHaveBeenCalledTimes(1);
});

it('skips an oversized tail and warns once without rereading it', async () => {
  env.read.mockResolvedValue(ok(page('x'.repeat(4 * 1024 * 1024))));
  await rememberNativeTail('host', 's', () => true);
  expect(env.read.mock.calls).toEqual([['host', { conversationId: 's', tail: true }]]);
  expect(env.write).not.toHaveBeenCalled();
  expect(env.warn).toHaveBeenCalledTimes(1);
});

it.each(['result', 'transport'])('warns on a %s failure without retrying a pending save', async kind => {
  let reject!: (error: Error) => void;
  let resolve!: (value: { ok: false; error: { message: string } }) => void;
  env.read.mockImplementationOnce(() => new Promise((done, failed) => { resolve = done; reject = failed; }));
  const first = rememberNativeTail('host', 's', () => true);
  rememberNativeTail('host', 's', () => true);
  if (kind === 'transport') reject(new Error('away'));
  else resolve({ ok: false, error: { message: 'unsupported' } });
  await first;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(env.read).toHaveBeenCalledTimes(1); expect(env.write).not.toHaveBeenCalled();
  expect(env.warn).toHaveBeenCalledTimes(1);
});
