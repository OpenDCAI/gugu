/** Agent questions are user state, not a disposable transcript cache. Commit before showing or delivering. */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import type { PendingRequest, Settlement } from '@gugu/session-core/session-record';
import { restoredAgentQuestion } from './agent-question-delivery';
import { activitySignal } from '../activity/signals';
import { registerAssistantQuestion, settleAssistantQuestion } from '../../../../sessionpage/assistant-work';

function file(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid question session ID');
  return join(resolveGuguHome(), 'agent-questions', `${sessionId}.json`);
}
export function readAgentQuestionRecords(sessionId: string): Settlement[] {
  let text: string;
  try { text = readFileSync(file(sessionId), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const data = JSON.parse(text) as { version: number; items: Settlement[] };
  if (data.version !== 1 || !Array.isArray(data.items) || data.items.some(item =>
    !['pending', 'resolved', 'cancelled'].includes(item.state) || !restoredAgentQuestion({ ...item, state: item.state === 'cancelled' ? 'pending' : item.state }))) {
    throw new Error('Agent question state is invalid');
  }
  return data.items;
}
function writeRecords(sessionId: string, items: Settlement[]): void {
  const target = file(sessionId);
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, items })}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The original write error remains authoritative. */ }
    throw error;
  }
}
export function rememberAgentQuestion(sessionId: string, question: PendingRequest | Settlement): void {
  const pending = 'state' in question ? question : { ...question, state: 'pending' as const, optionId: null, resolvedBy: null, resolvedAt: null };
  if (!restoredAgentQuestion(pending)) return; // Old process-bound/invalid cards never become durable approvals.
  const items = readAgentQuestionRecords(sessionId);
  if (items.some(item => item.itemId === pending.itemId)) return;
  writeRecords(sessionId, [...items, pending]);
  const payload = pending.origin?.payload as { sourceLink?: string } | undefined;
  registerAssistantQuestion(sessionId, pending.itemId, payload?.sourceLink);
  activitySignal({ event_id: `question.pending:${pending.itemId}`, kind: 'question.pending',
    session_id: sessionId, object_id: pending.itemId, occurred_at: Date.now() });
}
/** One synchronous atomic commit is the answer's CAS, before its inbox delivery or UI acknowledgement. */
export function settleAgentQuestionRecord(sessionId: string, itemId: string, result: { state: 'resolved' | 'cancelled'; optionId: string | null; by: string | null }): void {
  const items = readAgentQuestionRecords(sessionId);
  const current = items.find(item => item.itemId === itemId);
  if (!current) return; // Legacy non-persistent host cards keep their existing semantics.
  if (current.state === 'cancelled' && result.state === 'cancelled') return;
  if (current.state !== 'pending') throw new Error('This question is already settled');
  writeRecords(sessionId, items.map(item => item.itemId === itemId
    ? { ...item, state: result.state, optionId: result.optionId, resolvedBy: result.by, resolvedAt: Date.now() } : item));
  settleAssistantQuestion(sessionId, itemId);
  activitySignal({ event_id: `question.${result.state}:${itemId}`, kind: `question.${result.state}`,
    session_id: sessionId, object_id: itemId, occurred_at: Date.now() });
}
