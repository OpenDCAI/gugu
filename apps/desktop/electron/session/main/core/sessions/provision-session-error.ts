import { match, P } from 'ts-pattern';
import type { ProvisionStep } from '@shared/core/sessions/provisionEvents';
import { TimeoutSignal } from '../projects/utils';

export const SESSION_TIMEOUT_MS = 600_000;
export const TEARDOWN_SCRIPT_WAIT_MS = 10_000;

export type ProvisionSessionError =
  | { type: 'timeout'; message: string; timeout: number; step: ProvisionStep | null }
  | { type: 'error'; message: string };

export type TeardownSessionError =
  | { type: 'timeout'; message: string; timeout: number }
  | { type: 'error'; message: string };

export function toTeardownError(e: unknown): TeardownSessionError {
  if (e instanceof TimeoutSignal) return { type: 'timeout', message: e.message, timeout: e.ms };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

export function isProvisionSessionError(e: unknown): e is ProvisionSessionError {
  if (!e || typeof e !== 'object' || !('type' in e)) return false;
  const type = (e as { type?: string }).type;
  return type === 'timeout' || type === 'error';
}

export function formatTeardownSessionError(error: TeardownSessionError): string {
  return match(error)
    .with(P.union({ type: 'timeout' }, { type: 'error' }), (e) => e.message)
    .exhaustive();
}

export function formatProvisionSessionError(error: ProvisionSessionError): string {
  return match(error)
    .with({ type: 'timeout' }, (e) => (e.step ? `${e.message} (step: ${e.step})` : e.message))
    .with({ type: 'error' }, (e) => e.message)
    .exhaustive();
}
