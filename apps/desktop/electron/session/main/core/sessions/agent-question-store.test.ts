import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingRequest } from '@gugu/session-core/session-record';
import { readAgentQuestionRecords, rememberAgentQuestion, settleAgentQuestionRecord } from './agent-question-store';
import { restoredAgentQuestion } from './agent-question-delivery';
import { log } from '@main/lib/logger';

let root: string;
const id = 'agent-question:11111111-1111-4111-8111-111111111111';
const question = (): PendingRequest => ({ itemId: id, kind: 'question', title: 'Which Node?', options: [{ optionId: 'PATH', name: 'PATH' }],
  questions: [{ question: 'Which Node?', multiSelect: false, options: [{ optionId: 'PATH', name: 'PATH' }] }],
  origin: { source: 'agent-question', payload: { deliveryVersion: 1, answerMessageId: '22222222-2222-4222-8222-222222222222', sourceLink: null } } });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gugu-durable-question-')); vi.stubEnv('GUGU_HOME', root); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('durable agent question state, independent of transcript archives', () => {
  it('upgrades version one by renaming host to origin only: every card keeps its state, answer and delivery payload', () => {
    const { origin, ...common } = question();
    const old = (state: string, extra: Record<string, unknown> = {}) => ({ ...common, host: { kind: 'agent-question', payload: origin!.payload },
      state, optionId: null, resolvedBy: null, resolvedAt: null, ...extra });
    const target = join(root, 'agent-questions/session-1.json');
    mkdirSync(join(root, 'agent-questions'));
    const answers = '[{"selected":["PATH"]}]';
    const v1 = [old('pending'), old('resolved', { itemId: `${id}-r`, optionId: answers, resolvedBy: 'mobile', resolvedAt: 5 }), old('cancelled', { itemId: `${id}-c`, resolvedBy: 'desktop', resolvedAt: 6 })];
    writeFileSync(target, JSON.stringify({ version: 1, items: v1 }));
    const info = vi.spyOn(log, 'info');
    const records = readAgentQuestionRecords('session-1');
    expect(records).toEqual(v1.map(({ host, ...item }) => ({ ...item, origin: { source: host.kind, payload: host.payload } })));
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ version: 2, items: records });
    expect(readAgentQuestionRecords('session-1')).toEqual(records);
    expect(info).toHaveBeenCalledExactlyOnceWith('Agent question records upgraded to version 2', { sessionId: 'session-1', items: 3 });
  });
  it('commits a pending card immediately and rereads it without a running timeline or in-memory callback', () => {
    rememberAgentQuestion('session-1', question());
    const disk = JSON.parse(readFileSync(join(root, 'agent-questions/session-1.json'), 'utf8'));
    expect(disk.items[0]).toMatchObject({ itemId: id, state: 'pending' });
    expect(restoredAgentQuestion(readAgentQuestionRecords('session-1')[0])?.answer).toBeUndefined();
    expect(readAgentQuestionRecords('another-session')).toEqual([]);
  });
  it('commits the explicit answer before delivery, retaining the same outbox id on recovery', () => {
    rememberAgentQuestion('session-1', question());
    settleAgentQuestionRecord('session-1', id, { state: 'resolved', optionId: '[{"selected":["PATH"]}]', by: 'owner' });
    const recovered = restoredAgentQuestion(readAgentQuestionRecords('session-1')[0]);
    expect(recovered).toMatchObject({ answerMessageId: '22222222-2222-4222-8222-222222222222', answer: { answers: [{ selected: ['PATH'] }] } });
    expect(() => settleAgentQuestionRecord('session-1', id, { state: 'resolved', optionId: '[]', by: 'second' })).toThrow(/already settled/);
  });
  it('never revives a cancelled card, even when a timeline reports the old request again', () => {
    rememberAgentQuestion('session-1', question());
    settleAgentQuestionRecord('session-1', id, { state: 'cancelled', optionId: null, by: null });
    rememberAgentQuestion('session-1', question());
    expect(readAgentQuestionRecords('session-1')[0].state).toBe('cancelled');
    expect(restoredAgentQuestion(readAgentQuestionRecords('session-1')[0])).toBeNull();
  });
  it('fails publication when it cannot commit and refuses corrupt stored state instead of showing empty', () => {
    writeFileSync(join(root, 'agent-questions'), 'blocking-file');
    expect(() => rememberAgentQuestion('session-1', question())).toThrow();
    rmSync(join(root, 'agent-questions')); mkdirSync(join(root, 'agent-questions'));
    writeFileSync(join(root, 'agent-questions/session-1.json'), 'corrupt');
    expect(() => readAgentQuestionRecords('session-1')).toThrow();
    expect(() => rememberAgentQuestion('../escape', question())).toThrow(/session ID/);
  });
});
