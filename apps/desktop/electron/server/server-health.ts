/** Temporary projection for watchdogs shipped with the older two-process server. */
import path from 'node:path'
import { SUPERVISOR_HEALTH_FILE } from '@gugu/core'
import { writeJson } from './server-startup'

export const SUPERVISOR_HEALTH_MS = 30_000
export function writeSupervisorHealth(home: string, input: { version: string | null; pid: number; startedAt: number }, now = Date.now()): void {
  try { writeJson(path.join(home, 'data', SUPERVISOR_HEALTH_FILE), { ...input, confirmedRestart: true, at: now }) }
  catch { /* This transition-only diagnostic must not stop the server. */ }
}
