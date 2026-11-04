import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { SessionWriteTarget } from './write-bridge';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, enqueue: vi.fn() }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('No fixture'); return state.db; } }));
vi.mock('@main/core/sessions/session-life', () => ({ sessionLife: () => ({ enqueue: state.enqueue }) }));
vi.mock('@main/core/sessions/session-life-forks', () => ({ runtimeForkInput: () => null }));
vi.mock('@gugu/session-plugins/agents', () => ({ resolveSessionpageSessionIntegration: () => ({ identity: 'addressable', messageTransport: 'router' }) }));
vi.mock('@main/core/projects/utils', () => ({ resolveSession: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/acp/runtime-process/host', () => ({ getAcpRuntimeClient: vi.fn() }));
vi.mock('@main/core/acp/session-summary-reader', () => ({ readAcpSessionSummaries: async () => ({}) }));
vi.mock('@main/core/pty/answer-question', () => ({ writeKeyBeats: vi.fn() }));
vi.mock('@main/core/agents/plugin-registry', () => ({ isValidProviderId: () => true, getPlugin: vi.fn() }));
vi.mock('./turn-files', () => ({ turnFileText: async () => ({ text: '[file resolved for the provider]', images: [], files: [] }) }));

import { enqueuePending } from '../sessions/session-pending';
import { acceptPendingSessionDirectMessage, readAcceptedMessage, rejectPendingSessionDirectMessage } from '../sessions/sendMessage';
import { setSessionMessageRouter } from '../sessions/session-message-router';
import { deliverSessionText } from './write-bridge';
import { priorInputAdmission } from './input-admission';

describe('task input custody from the real write receipts', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db;
    fixture.sqlite.exec(`INSERT INTO projects (id,name,path) VALUES ('p','P','/repo');
      INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES ('s','p','codex','pty','{"version":"1","type":"pty"}');`);
    state.enqueue.mockImplementation(enqueuePending);
    setSessionMessageRouter(async (_sessionId, message) => ({ status: 'accepted', messageId: message.id }));
  });
  afterEach(() => { setSessionMessageRouter(null); fixture.close(); state.db = undefined; state.enqueue.mockReset(); });

  it.each(['accepted', 'failed'] as const)('retains the original PTY file payload when a queued receipt becomes %s', async state => {
    setSessionMessageRouter(async () => ({ status: 'not-ready', preserve: true, reason: 'provider unavailable' }));
    const files = [{ itemId: 'd01ce639-d1ab-4880-b578-c9cba0ff31d8', version: 1, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 4 }];
    const target = { id: 's', projectId: 'p', runtime: 'pty', providerId: 'codex' } as SessionWriteTarget;
    await expect(deliverSessionText(target, 'caption', 'input', files)).rejects.toThrow('kept');
    const input = { conversationId: 's', clientMessageId: 'input', text: 'caption', files };
    expect(priorInputAdmission(input)).toBe('accepted');
    if (state === 'accepted') acceptPendingSessionDirectMessage('s', 'input');
    else rejectPendingSessionDirectMessage('s', 'input', new Error('native startup failed'));
    expect(JSON.parse(readAcceptedMessage('input')!.metadata!).state).toBe(state);
    expect(priorInputAdmission(input)).toBe('accepted');
    expect(priorInputAdmission({ ...input, files: [{ ...files[0]!, version: 2 }] })).toBe('uncertain');
  });

  it.each([
    ['acp', false], ['acp', true], ['pty', false], ['pty', true],
  ] as const)('recognizes the original %s input after a lost ACK (files=%s)', async (runtime, withFiles) => {
    fixture.sqlite.prepare('UPDATE sessions SET runtime=? WHERE id=?').run(runtime, 's');
    const target = { id: 's', projectId: 'p', runtime, providerId: 'codex' } as SessionWriteTarget;
    const files = withFiles ? [{ itemId: 'd01ce639-d1ab-4880-b578-c9cba0ff31d8', version: 1, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 4 }] : undefined;
    await deliverSessionText(target, '  original caption  ', 'input', files);
    const receipt = readAcceptedMessage('input');
    expect(receipt).toBeTruthy();
    expect(JSON.parse(receipt!.metadata!).kind).toBe('session-direct');
    // The initial response was lost; a later provider refusal must not retract this custody.
    fixture.sqlite.prepare("UPDATE sessions SET provider='' WHERE id='s'").run();
    const input = { conversationId: 's', clientMessageId: 'input', text: 'original caption', files };
    expect(priorInputAdmission(input)).toBe('accepted');
    expect(priorInputAdmission({ ...input, text: 'changed caption' })).toBe('uncertain');
    if (files) expect(priorInputAdmission({ ...input, files: [{ ...files[0]!, version: 2 }] })).toBe('uncertain');
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM messages WHERE id='input'").get()).toEqual({ n: 1 });
  });
});
