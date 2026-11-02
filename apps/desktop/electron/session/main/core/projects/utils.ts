import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { isRetiredRemoteWorkspace, RETIRED_REMOTE_WORKSPACE_MESSAGE } from '@main/core/workspaces/resolve-workspace-kind';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { sessionWorkspaceManager } from '../sessions/session-workspace-manager';

/** 这条会话挂载出来的运行时;没挂着就是 null。 */
export function resolveSession(_projectId: string, sessionId: string) {
  return sessionWorkspaceManager.getSession(sessionId) ?? null;
}

export function resolveWorkspace(_projectId: string, workspaceId: string) {
  return workspaceRegistry.get(workspaceId) ?? null;
}

/**
 * A workspace's local path from its persisted record: the path mounting it uses, known before (or without) mounting
 * it. Null when the row is missing or has no path. A retired remote row is refused with the same user-facing copy
 * mounting refuses it with: its stored path is not a folder on this computer.
 */
export function persistedWorkspacePath(workspaceId: string): string | null {
  const row = db
    .select({ path: workspaces.path, kind: workspaces.kind, type: workspaces.type, location: workspaces.location })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  if (row && isRetiredRemoteWorkspace(row)) throw new Error(RETIRED_REMOTE_WORKSPACE_MESSAGE);
  return row?.path ?? null;
}

export class TimeoutSignal extends Error {
  constructor(readonly ms: number) {
    super(`Operation timed out after ${ms}ms`);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutSignal(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type TimeoutError<T extends string> = {
  type: 'timeout';
  scope: T;
  timeout: number;
  message?: string;
};

export function timeoutError<T extends string>(
  scope: T,
  timeout: number,
  message?: string
): TimeoutError<T> {
  return {
    type: 'timeout',
    scope,
    timeout,
    message,
  };
}

export type AbortError<T extends string> = {
  type: 'abort';
  scope: T;
  message?: string;
};

export function abortError<T extends string>(scope: T, message?: string): AbortError<T> {
  return {
    type: 'abort',
    scope,
    message,
  };
}
