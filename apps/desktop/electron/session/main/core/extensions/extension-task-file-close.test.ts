import { expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionTaskPages, type TaskPageNative } from './extension-task-pages';
import { readTaskFilePayloads, type TaskFileSource } from './task-file-payloads';
import { cancelExtensionSessionCalls, revokeExtensionProgramAccess } from './extension-program-access';

const ITEM = '11111111-1111-4111-8111-111111111111', CHAT = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
function caller(callId: string, sessionId = 'file-close-task', controller = new AbortController()) {
  return { kind: 'program', pageId: -985, extensionId: 'file-close-app', callingSession: sessionId, callingAgent: AGENT,
    signal: controller.signal, hear: vi.fn(), filePage: () => ({ pageId: -985, extensionId: 'file-close-app', callId,
      signal: controller.signal, asAgent: AGENT, handed: { id: ITEM, chat: CHAT } }) } as unknown as BridgeCaller;
}
function fixture() {
  const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<{ n: number; text: string }>();
  const closures = new Set<(reason: string) => void>();
  const source: TaskFileSource = { metadata: vi.fn(async () => ({ id: ITEM, chat: CHAT, name: 'card.txt', contentType: 'text/plain', version: 1, size: 3 })),
    version: vi.fn(async page => { if (page.callId === 'held') { entered.resolve(); return held.promise; } return { n: 1, text: 'abc' }; }) };
  const native: TaskPageNative = { projectId: 'file-close-project', title: '', url: 'https://example.org',
    protocol: { attached: false, send: vi.fn(async () => ({})), onMessage: () => () => {},
      onClose: fn => { closures.add(fn); return () => { closures.delete(fn); }; }, close: vi.fn() },
    setActive: vi.fn(), release: vi.fn() };
  const pages = new ExtensionTaskPages(() => {}, async () => native, vi.fn(),
    (from, refs, signal) => readTaskFilePayloads(from, refs, signal, source));
  return { pages, native, closures, source, entered, held };
}

it.each(['release', 'native-close', 'archive', 'delete-project', 'program-exit', 'task-stop', 'call-end', 'revocation'] as const)(
  '%s settles a file-service wait before that service supplies its late result', async how => {
    const { pages, closures, entered, held } = fixture(), controller = new AbortController(), from = caller('held', 'file-close-task', controller);
    const lease = await pages.acquire(from, { watchId: how });
    let settled: { value?: unknown; error?: unknown } | undefined;
    const work = pages.filePayloads(from, { id: lease.id, refs: [{ file: ITEM }] }).then(value => { settled = { value }; }, error => { settled = { error }; });
    try {
      await entered.promise;
      if (how === 'release') await pages.release(from, lease.id);
      else if (how === 'native-close') for (const close of [...closures]) close('native tab closed');
      else if (how === 'archive') pages.closeScope({ sessionId: 'file-close-task' });
      else if (how === 'delete-project') pages.closeScope({ projectId: 'file-close-project' });
      else if (how === 'program-exit') await pages.closeProgram(from.pageId);
      else if (how === 'task-stop') cancelExtensionSessionCalls('file-close-task');
      else if (how === 'call-end') controller.abort(new Error('The tool call ended'));
      else revokeExtensionProgramAccess('file-close-app');
      // Drain this turn, not a timed retry. The service is deliberately still unresolved.
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toEqual({ error: expect.any(Error) });
      await expect(pages.filePayloads(from, { id: lease.id, refs: [{ file: ITEM }] })).rejects.toThrow();
    } finally {
      held.resolve({ n: 1, text: 'abc' }); await work; await pages.closeProgram(from.pageId);
    }
    expect(settled).not.toHaveProperty('value');
  });

it('aborts payloads when close begins even while native cleanup is still pending', async () => {
  const { pages, native, entered, held } = fixture(), from = caller('held');
  const cleanup = Promise.withResolvers<void>(); native.cleanup = () => cleanup.promise;
  const lease = await pages.acquire(from, { watchId: 'cleanup-held' });
  let failed = false;
  const work = pages.filePayloads(from, { id: lease.id, refs: [{ file: ITEM }] }).then(() => {}, () => { failed = true; });
  await entered.promise;
  const closing = pages.release(from, lease.id);
  try {
    await new Promise(resolve => setImmediate(resolve)); expect(failed).toBe(true);
    expect(native.release).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve(); held.resolve({ n: 1, text: 'abc' }); await closing; await work; await pages.closeProgram(from.pageId);
  }
});

it('closing A’s lease does not abort another live lease or require its independent call to finish', async () => {
  const { pages, entered, held } = fixture(), a = caller('held'), b = caller('other');
  const first = await pages.acquire(a, { watchId: 'a' }), second = await pages.acquire(b, { watchId: 'b' });
  let failed = false;
  const work = pages.filePayloads(a, { id: first.id, refs: [{ file: ITEM }] }).then(() => {}, () => { failed = true; });
  try {
    await entered.promise; await pages.release(a, first.id);
    await new Promise(resolve => setImmediate(resolve)); expect(failed).toBe(true);
    const payloads = await pages.filePayloads(b, { id: second.id, refs: [{ file: ITEM }] });
    expect(new TextDecoder().decode(payloads[0]!.bytes)).toBe('abc');
    expect(b.signal?.aborted).toBe(false);
  } finally { held.resolve({ n: 1, text: 'abc' }); await work; await pages.closeProgram(a.pageId); }
});
