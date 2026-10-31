import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { activityProof } from '../../../../apps/desktop/electron/server/server-layout'
import { parseServerUpdateState } from '../../../../packages/core/src/cloud/deviceHostInfo'
import {
  BOOT_READY_TIMEOUT_MS,
  INITIAL_ACCOUNT_STATE,
  parseAccountState,
  serializeAccountState,
  step,
  VERSION_FAILURE_COOLDOWN_MS,
  type AccountEvent,
  type AccountState,
} from '../../../../apps/desktop/electron/server/server-account-machine'

const T = 1_000_000
const OLD = '0.3.0'
const NEW = '0.3.1'
type Tick = Extract<AccountEvent, { type: 'tick' }>
const tick = (over: Partial<Tick> = {}): Tick => ({
  type: 'tick', now: T, supervisor: OLD, managed: false, target: NEW, ready: true, request: null, proof: 'idle', child: 'running', ...over,
})
const at = (over: Partial<AccountState> = {}): AccountState => ({ ...INITIAL_ACCOUNT_STATE, supervisor: OLD, child: 'running', ...over })

describe('account version state machine: one row per (state, event)', () => {
  it.each<[string, AccountState, Tick, AccountState['phase'], string[]]>([
    ['already on target', at(), tick({ target: OLD }), { kind: 'running' }, []],
    ['target missing → stage once', at(), tick({ ready: false }), { kind: 'staging', target: NEW }, ['stage']],
    ['still staging → no second stage', at({ phase: { kind: 'staging', target: NEW } }), tick({ ready: false }), { kind: 'staging', target: NEW }, []],
    ['ready + idle → wait for a confirmed restart, never stop a running account on its own', at(), tick(), { kind: 'waiting', target: NEW }, []],
    ['ready + busy → wait', at(), tick({ proof: 'busy' }), { kind: 'waiting', target: NEW }, []],
    ['old binary without a fresh own heartbeat (N5c) → wait', at(), tick({ proof: 'unverified' }), { kind: 'waiting', target: NEW }, []],
    ['cold (never started) → take the target without a restart', at({ child: 'none' }), tick({ proof: 'cold', child: 'none' }), { kind: 'booting', since: T, quickExits: 0 }, []],
    ['confirmed restart for the target → switch now, even when busy', at(), tick({ proof: 'busy', request: { at: T - 1, confirmed: true, target: NEW } }),
      { kind: 'booting', since: T, quickExits: 0, request: T - 1 }, ['consumeRequest', 'restart']],
    ['an old account process\'s confirmation (no target) confirms the current target', at(), tick({ proof: 'busy', request: { at: T - 1, confirmed: true } }),
      { kind: 'booting', since: T, quickExits: 0, request: T - 1 }, ['consumeRequest', 'restart']],
    ['managed: the supervisor package must pass account admission before an unpinned account counts as on it',
      at({ child: 'none' }), tick({ managed: true, target: OLD, ready: false, proof: 'cold', child: 'none' }), { kind: 'staging', target: OLD }, ['stage']],
    ['managed: once admitted, a cold account takes it without a restart',
      at({ child: 'none' }), tick({ managed: true, target: OLD, proof: 'cold', child: 'none' }), { kind: 'booting', since: T, quickExits: 0 }, []],
  ])('%s', (_name, state, event, phase, expected) => {
    const result = step(state, event)
    expect(result.state.phase).toEqual(phase)
    expect(result.effects.filter((e) => e.type !== 'log').map((e) => e.type)).toEqual(expected)
  })

  it('booting: first own heartbeat → running + switched; three quick exits → rolled back to previous with a boot cooldown', () => {
    const booting = at({ version: NEW, previous: OLD, phase: { kind: 'booting', since: T, quickExits: 0, request: 7 } })
    expect(step(booting, tick({ now: T + 5, proof: 'busy' })).state).toMatchObject({ phase: { kind: 'running' }, lastOutcome: { kind: 'switched', target: NEW, request: 7 } })
    let s = booting
    for (let i = 0; i < 3; i++) s = step(s, { type: 'childExited', now: T + i, quick: true }).state
    expect(s).toMatchObject({ version: OLD, previous: null, phase: { kind: 'running' }, lastOutcome: { kind: 'rolledBack', bad: NEW, back: OLD, request: 7 } })
    expect(s.failures[NEW]).toMatchObject({ cause: 'boot', until: T + 2 + VERSION_FAILURE_COOLDOWN_MS })
    expect(step(booting, { type: 'childExited', now: T, quick: false }).state.phase).toEqual(booting.phase)
  })

  it('booting: alive without its own heartbeat past the deadline → rolled back and the stuck child restarted', () => {
    const booting = at({ version: NEW, previous: OLD, phase: { kind: 'booting', since: T, quickExits: 0 } })
    const late = step(booting, tick({ now: T + BOOT_READY_TIMEOUT_MS, proof: 'unverified' }))
    expect(late.state).toMatchObject({ version: OLD, lastOutcome: { kind: 'rolledBack', bad: NEW } })
    expect(late.effects.map((e) => e.type)).toContain('restart')
  })

  it('cooldown: a boot failure refuses a plain retry (and answers it), lifts only for a later confirmed restart of that version', () => {
    const failed = at({ failures: { [NEW]: { cause: 'boot', at: T - 10, until: T + 1000, attempts: 1 } } })
    expect(step(failed, tick()).state.phase).toEqual({ kind: 'failed', target: NEW })
    const plain = step(failed, tick({ request: { at: T - 5, confirmed: false } }))
    expect(plain.state).toMatchObject({ phase: { kind: 'failed', target: NEW }, lastOutcome: { kind: 'refused', cause: 'boot', request: T - 5 } })
    expect(plain.effects.map((e) => e.type)).toEqual(['consumeRequest'])
    const otherTarget = step(failed, tick({ request: { at: T - 5, confirmed: true, target: '0.3.2' } }))
    expect(otherTarget.state.phase.kind).toBe('failed')
    const confirmed = step(failed, tick({ request: { at: T - 5, confirmed: true, target: NEW } }))
    expect(confirmed.state.phase).toMatchObject({ kind: 'booting' })
    expect(confirmed.state.failures[NEW]).toBeUndefined()
  })

  it('cooldown: an install failure is lifted by any later request; expired failures are forgotten', () => {
    const failed = at({ failures: { [NEW]: { cause: 'install', at: T - 10, until: T + 1000, attempts: 1 } } })
    expect(step(failed, tick({ request: { at: T - 5, confirmed: false } })).state.phase.kind).toBe('waiting')
    expect(step(failed, tick({ request: { at: T - 20, confirmed: false } })).state.phase.kind).toBe('failed')
    expect(step(failed, tick({ now: T + 1000 })).state.failures).toEqual({})
  })

  it('stage failures carry their cause; a confirmed staging request gets its verdict; a 404 backs off before retrying', () => {
    const staging = at({ phase: { kind: 'staging', target: NEW, request: 3 } })
    const boot = step(staging, { type: 'stageFailed', now: T, version: NEW, cause: 'boot' })
    expect(boot.state).toMatchObject({ phase: { kind: 'failed', target: NEW }, lastOutcome: { kind: 'failed', cause: 'boot', request: 3 } })
    expect(boot.effects.map((e) => e.type)).toContain('consumeRequest')
    const missing = step(at(), { type: 'stageFailed', now: T, version: NEW, cause: 'install', notPublished: true })
    expect(missing.state.failures[NEW]!.until).toBe(T + 5 * 60 * 1000)
    expect(step(missing.state, { type: 'stageFailed', now: T, version: NEW, cause: 'install', notPublished: true }).state.failures[NEW]!.until).toBe(T + 10 * 60 * 1000)
  })

  it('a plain request answered "waiting" once; a request for the current version is answered "switched"', () => {
    const waiting = step(at(), tick({ proof: 'busy', request: { at: 9, confirmed: false } })).state
    expect(waiting.lastOutcome).toMatchObject({ kind: 'waiting', target: NEW, request: 9 })
    expect(step({ ...waiting, lastOutcome: { ...waiting.lastOutcome!, at: 0 } }, tick({ proof: 'busy', request: { at: 9, confirmed: false } })).state.lastOutcome!.at).toBe(0)
    expect(step(at(), tick({ target: OLD, request: { at: 9, confirmed: true, target: OLD } })).state.lastOutcome).toMatchObject({ kind: 'switched', target: OLD, request: 9 })
  })
})

describe('state file: one atomic file, a superset of what old readers parse', () => {
  it('round-trips the full state and still projects state/version/reason for an old account binary', () => {
    const failed = at({ phase: { kind: 'failed', target: NEW }, failures: { [NEW]: { cause: 'boot', at: T, until: T + 1, attempts: 1 } } })
    const text = serializeAccountState(failed, T)
    expect(parseAccountState(text)).toEqual(failed)
    // The old reader (device row heartbeat of a 1059 account) sees only these fields.
    expect(parseServerUpdateState(text, T)).toEqual({ state: 'failed', version: NEW, reason: 'boot-failed' })
    expect(parseServerUpdateState(serializeAccountState(at({ phase: { kind: 'waiting', target: NEW } }), T), T)).toEqual({ state: 'ready', version: NEW })
    expect(parseServerUpdateState(serializeAccountState(at({ phase: { kind: 'staging', target: NEW } }), T), T)).toEqual({ state: 'downloading', version: NEW })
    expect(parseServerUpdateState(serializeAccountState(at(), T), T)).toBeNull()
  })
})

describe('activity proof: only the current process\'s own fresh heartbeat counts', () => {
  it('idle / busy from a fresh pid-matched heartbeat; anything else is unverified', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-proof-'))
    try {
      const now = 100_000
      const expected = { pid: process.pid, startedAt: 99_000 }
      const write = (patch: object) => fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify({ busy: false, at: now, ...expected, ...patch }))
      expect(activityProof(dir, now, expected)).toBe('unverified')
      for (const patch of [{ busy: null }, { at: 1 }, { at: now + 1 }, { pid: process.pid + 1 }, { startedAt: 98_000 }]) {
        write(patch)
        expect(activityProof(dir, now, expected), JSON.stringify(patch)).toBe('unverified')
      }
      write({ busy: true })
      expect(activityProof(dir, now, expected)).toBe('busy')
      write({})
      expect(activityProof(dir, now, expected)).toBe('idle')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
