import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Admission receipts cover preparation before an adapter exists. They are not a
// second session list: attached ownership still comes only from ACP / PTY owners.
let preparing = 0;
let lease: { token: string; target: string; until: number } | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const held = () => lease !== null && lease.until > performance.now();

export function beginSessionStartAdmission(): () => void {
  if (held()) throw new Error('This machine is switching versions; retry after it reconnects');
  preparing++;
  notify();
  let released = false;
  return () => { if (!released) { released = true; preparing--; notify(); } };
}

export async function withSessionStartAdmission<T>(work: () => Promise<T>): Promise<T> {
  const release = beginSessionStartAdmission();
  try { return await work(); } finally { release(); }
}

export function hasSessionStartAdmission(): boolean { return preparing > 0; }
export function onSessionStartAdmissionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A local supervisor closes admission before it reads ownership, then stops this PID. */
export async function prepareSessionVersionHandoff(
  payload: unknown,
  read: () => Promise<{ busy: boolean }>,
): Promise<{ result: { ready: boolean; pid: number; token?: string; target?: string } }> {
  if (!payload || typeof payload !== 'object') throw new Error('Missing version handoff target');
  const request = payload as { target?: unknown; release?: unknown };
  if (typeof request.target !== 'string' || !request.target) throw new Error('Missing version handoff target');
  if (typeof request.release === 'string') {
    if (lease?.token === request.release && lease.target === request.target) { lease = null; notify(); }
    return { result: { ready: false, pid: process.pid } };
  }
  if (held()) return { result: { ready: false, pid: process.pid } };
  const mine = { token: randomUUID(), target: request.target, until: performance.now() + 60_000 };
  lease = mine;
  try {
    if (preparing > 0 || (await read()).busy || preparing > 0 || !held() || lease !== mine) {
      if (lease === mine) lease = null;
      return { result: { ready: false, pid: process.pid } };
    }
    // If the supervisor dies or loses this reply, admission reopens on expiry.
    return { result: { ready: true, pid: process.pid, target: mine.target, token: mine.token } };
  } catch (error) {
    if (lease === mine) lease = null;
    throw error;
  }
}
