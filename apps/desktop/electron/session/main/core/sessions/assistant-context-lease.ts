import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { messages, sessions } from '@main/db/schema';
import { notifySessionLive } from './session-message-router';
export { assistantConversationVersion } from './assistant-context-version';

// A bounded, persisted lease survives a lost migration worker, never an indefinite lock.
export const ASSISTANT_CONTEXT_LEASE_MS = 45_000;
const admissions = new Map<string, number>();
const maintenance = new Map<string, AssistantContextLease>();
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
const enabled = new Set<string>();
/** Enabled only by a trusted assistant-role capability injection. */
export function enableAssistantContextGate(sessionId: string): void { enabled.add(sessionId); }
export type AssistantContextLease = { sessionId: string; token: string; expiresAt: number; previousProviderSessionId: string; candidateProviderSessionId: string };

export function assistantContextMigrationHeld(sessionId: string, now = Date.now()): boolean {
  if ((maintenance.get(sessionId)?.expiresAt ?? 0) > now) return true;
  const [row] = db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  const lease = row?.config?.type === 'acp' ? row.config.assistantContextMigration : null;
  return lease?.state === 'running' && lease.expiresAt > now;
}

/** All native turn admissions share this gate, including the renderer and detached inbox. */
export async function withAssistantContextAdmission<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  while (enabled.has(sessionId) && assistantContextMigrationHeld(sessionId)) await new Promise(resolve => setTimeout(resolve, 50));
  admissions.set(sessionId, (admissions.get(sessionId) ?? 0) + 1);
  try { return await run(); }
  finally {
    const count = (admissions.get(sessionId) ?? 1) - 1;
    if (count) admissions.set(sessionId, count); else admissions.delete(sessionId);
  }
}

export function claimAssistantContextMigration(sessionId: string, providerSessionId: string, now = Date.now()): AssistantContextLease | null {
  enableAssistantContextGate(sessionId);
  if (admissions.has(sessionId)) return null;
  const claimed = db.transaction(tx => {
    const [row] = tx.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!row || row.config?.type !== 'acp' || row.providerSessionId !== providerSessionId || row.agentStatus === 'working'
      || row.config.messageOutbox?.length || row.config.initialQueue?.length) return null;
    const previous = row.config?.assistantContextMigration;
    if (previous?.state === 'completed' || (previous?.state === 'running' && previous.expiresAt > now)) return null;
    const waiting = tx.select({ id: messages.id }).from(messages).where(and(eq(messages.sessionId, sessionId),
      sql`json_extract(${messages.metadata}, '$.state') in ('queued', 'deferred', 'dispatching')`)).limit(1).all();
    if (waiting.length) return null;
    const lease = { sessionId, token: randomUUID(), expiresAt: now + ASSISTANT_CONTEXT_LEASE_MS,
      previousProviderSessionId: providerSessionId, candidateProviderSessionId: randomUUID() };
    tx.update(sessions).set({ config: { ...row.config,
      assistantContextBranches: [...new Set([...(row.config.assistantContextBranches ?? []), providerSessionId, lease.candidateProviderSessionId])],
      assistantContextMigration: { ...lease, version: 1, state: 'running' } } })
      .where(eq(sessions.id, sessionId)).run();
    return lease;
  });
  if (claimed) {
    maintenance.set(sessionId, claimed);
    const timer = setTimeout(() => {
      abandonAssistantContextMigration(claimed, 'Lease expired');
      notifySessionLive(sessionId);
    }, Math.max(0, claimed.expiresAt - Date.now()));
    timer.unref();
    watchdogs.set(claimed.token, timer);
  }
  return claimed;
}

/** A late or timed-out worker cannot clear a newer lease or promote its candidate. */
export function abandonAssistantContextMigration(lease: AssistantContextLease, reason: string): void {
  clearTimeout(watchdogs.get(lease.token)); watchdogs.delete(lease.token);
  if (maintenance.get(lease.sessionId)?.token === lease.token) maintenance.delete(lease.sessionId);
  db.transaction(tx => {
    const [row] = tx.select().from(sessions).where(eq(sessions.id, lease.sessionId)).all();
    if (!row || row.config?.type !== 'acp') return;
    const current = row.config.assistantContextMigration;
    if (current?.state !== 'running' || current.token !== lease.token) return;
    tx.update(sessions).set({ config: { ...row.config, assistantContextMigration: {
      ...current, state: 'abandoned', reason, finishedAt: new Date().toISOString(),
    } } }).where(eq(sessions.id, lease.sessionId)).run();
  });
}
