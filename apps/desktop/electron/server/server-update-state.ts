/** The installation's single update record, shared by automatic and controller activation. */
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_UPDATE_STATE_FILE } from '@gugu/core'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import type { FailureCause, Outcome } from '@gugu/core/shared/serverVersionOutcome'
import { writeJson } from './server-startup'

export type ServerUpdateStateWriter = {
  /** reason 'unreachable' = 连不上下载站(桌面经 SSH 读到它就把包的字节传过来,见 match-version-cli.ts)。 */
  set: (state: ServerUpdateRecord['state'], version: string, reason?: 'unreachable', fields?: Partial<ServerUpdateRecord>) => void
  clear: () => void
}

export type ServerUpdateRecord = {
  state: 'idle' | 'downloading' | 'ready' | 'switching' | 'failed'
  version: string
  at: number
  previous?: string
  cause?: FailureCause
  until?: number
  attempts?: number
  lastOutcome?: Outcome
}

export function createServerUpdateStateWriter(home: string, now: () => number = Date.now): ServerUpdateStateWriter {
  const file = path.join(home, 'data', SERVER_UPDATE_STATE_FILE)
  return {
    set(state, version, reason, fields) {
      const previous = readUpdateRecord(home)
      writeJson(file, { state, version, at: now(), ...(reason ? { reason } : {}),
        ...(previous?.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
        ...(previous?.previous ? { previous: previous.previous } : {}), ...fields })
    },
    clear() {
      fs.rmSync(file, { force: true })
    },
  }
}

export function readUpdateRecord(home: string): ServerUpdateRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, 'data', SERVER_UPDATE_STATE_FILE), 'utf8')) as ServerUpdateRecord
    return ['idle', 'downloading', 'ready', 'switching', 'failed'].includes(value.state)
      && isServerVersion(value.version) && Number.isFinite(value.at) ? value : null
  } catch { return null }
}

