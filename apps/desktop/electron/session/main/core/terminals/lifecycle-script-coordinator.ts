import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { Workspace } from '@main/core/workspaces/workspace';
import { events } from '@main/lib/events';
import { redactDiagnosticLog } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import {
  lifecycleScriptStatusChannel,
  type LifecycleScriptOrigin,
  type LifecycleScriptType,
} from '@shared/core/sessions/provisionEvents';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import type { LifecycleScriptExecutionResult } from '../workspaces/workspace-lifecycle-service';

export type LifecycleScriptPolicy = {
  exit?: boolean;
  waitForExit?: boolean;
  respawnAfterExit?: boolean;
  timeoutMs?: number;
  logFailure: boolean;
  surfaceFailure: boolean;
  continueOnFailure: boolean;
};

export type LifecycleScriptCoordinatorResult =
  | { kind: 'succeeded'; result: LifecycleScriptExecutionResult }
  | { kind: 'failed'; message: string; result?: LifecycleScriptExecutionResult }
  | { kind: 'stopped' }
  | { kind: 'already-running' };

const activePtySessionIds = new Set<string>();
const stoppedPtySessionIds = new Set<string>();

class LifecycleScriptTimeout extends Error {
  constructor(readonly ms: number) {
    super(`Lifecycle script timed out after ${ms}ms`);
  }
}

function withLifecycleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LifecycleScriptTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function lifecycleScriptPtySessionId({
  projectId,
  workspaceId,
  type,
}: {
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
}): string {
  return makePtySessionId(projectId, workspaceId, createLifecycleScriptTerminalId(type));
}

export function stopLifecycleScriptSession({
  projectId,
  workspaceId,
  type,
  origin,
}: {
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
}): boolean {
  const ptySessionId = lifecycleScriptPtySessionId({ projectId, workspaceId, type });
  const pty = ptySessionRegistry.get(ptySessionId);
  if (!pty) return false;
  if (!activePtySessionIds.has(ptySessionId)) return false;
  if (stoppedPtySessionIds.has(ptySessionId)) return false;

  stoppedPtySessionIds.add(ptySessionId);
  pty.kill();
  events.emit(lifecycleScriptStatusChannel, {
    projectId,
    workspaceId,
    type,
    origin,
    status: 'stopped',
  });
  return true;
}

function labelFor(type: LifecycleScriptType): string {
  return type[0].toUpperCase() + type.slice(1);
}

function isSuccessfulResult(result: LifecycleScriptExecutionResult): boolean {
  if (result.kind === 'started' || result.kind === 'already-running') return true;
  return result.signal === undefined && (result.exitCode === 0 || result.exitCode === undefined);
}

function failureMessage(type: LifecycleScriptType, result: LifecycleScriptExecutionResult): string {
  const label = labelFor(type);
  if (result.kind === 'started') return `${label} script did not report an exit status.`;
  if (result.kind === 'already-running') return `${label} script is already running.`;
  if (result.signal !== undefined) return `${label} script exited with signal ${result.signal}.`;
  return `${label} script exited with code ${result.exitCode ?? 'unknown'}.`;
}

export async function runLifecycleScriptWithPolicy({
  workspace,
  projectId,
  workspaceId,
  type,
  script,
  shellSetup,
  origin,
  policy,
  logPrefix,
}: {
  workspace: Workspace;
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
  script: string;
  shellSetup?: string;
  origin: LifecycleScriptOrigin;
  policy: LifecycleScriptPolicy;
  logPrefix: string;
}): Promise<LifecycleScriptCoordinatorResult> {
  const ptySessionId = lifecycleScriptPtySessionId({ projectId, workspaceId, type });
  if (activePtySessionIds.has(ptySessionId)) {
    return { kind: 'already-running' };
  }

  activePtySessionIds.add(ptySessionId);
  events.emit(lifecycleScriptStatusChannel, {
    projectId,
    workspaceId,
    type,
    origin,
    status: 'running',
  });

  let result: LifecycleScriptExecutionResult | undefined;
  try {
    const execution = workspace.lifecycleService.runLifecycleScript(
      { type, script, shellSetup },
      {
        exit: policy.exit ?? true,
        waitForExit: policy.waitForExit ?? true,
        respawnAfterExit: policy.respawnAfterExit ?? false,
      }
    );
    result =
      policy.timeoutMs === undefined
        ? await execution
        : await withLifecycleTimeout(execution, policy.timeoutMs);

    if (result.kind === 'already-running') {
      return { kind: 'already-running' };
    }

    if (stoppedPtySessionIds.delete(ptySessionId)) {
      return { kind: 'stopped' };
    }

    if (isSuccessfulResult(result)) {
      events.emit(lifecycleScriptStatusChannel, {
        projectId,
        workspaceId,
        type,
        origin,
        status: 'succeeded',
        ...(result.kind === 'exited' ? { exitCode: result.exitCode } : {}),
      });
      return { kind: 'succeeded', result };
    }

    return handleFailure({
      projectId,
      workspaceId,
      type,
      origin,
      policy,
      logPrefix,
      message: failureMessage(type, result),
      result,
    });
  } catch (error: unknown) {
    if (stoppedPtySessionIds.delete(ptySessionId)) {
      return { kind: 'stopped' };
    }

    const message =
      error instanceof LifecycleScriptTimeout
        ? `${labelFor(type)} script timed out after ${policy.timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : `${labelFor(type)} script failed to run.`;

    return handleFailure({
      projectId,
      workspaceId,
      type,
      origin,
      policy,
      logPrefix,
      message,
      result,
      error,
    });
  } finally {
    activePtySessionIds.delete(ptySessionId);
    stoppedPtySessionIds.delete(ptySessionId);
  }
}

function handleFailure({
  projectId,
  workspaceId,
  type,
  origin,
  policy,
  logPrefix,
  message,
  result,
  error,
}: {
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
  policy: LifecycleScriptPolicy;
  logPrefix: string;
  message: string;
  result?: LifecycleScriptExecutionResult;
  error?: unknown;
}): LifecycleScriptCoordinatorResult {
  const outputTail =
    result?.kind === 'exited' && result.outputTail
      ? redactDiagnosticLog(result.outputTail)
      : undefined;

  if (policy.logFailure) {
    log.error(`${logPrefix}: ${type} script failed`, {
      workspaceId,
      error: message,
      exitCode: result?.kind === 'exited' ? result.exitCode : undefined,
      signal: result?.kind === 'exited' ? result.signal : undefined,
      outputTail,
    });
  }

  events.emit(lifecycleScriptStatusChannel, {
    projectId,
    workspaceId,
    type,
    origin,
    status: 'failed',
    message,
    surfaceFailure: policy.surfaceFailure,
    ...(result?.kind === 'exited'
      ? {
          exitCode: result.exitCode,
          signal: result.signal,
        }
      : {}),
  });

  const failure = { kind: 'failed' as const, message, result };
  if (policy.continueOnFailure) return failure;
  throw error ?? new Error(message);
}
