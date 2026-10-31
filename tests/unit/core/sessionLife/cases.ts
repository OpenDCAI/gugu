import assert from 'node:assert/strict'
import { hydrateLife, LifeProtocolError, OUTCOME_UNKNOWN, shouldStartOnHydrate, step } from '../../../../packages/core/src/local/session-life/step.ts'
import { STAGES } from '../../../../packages/core/src/local/session-life/types.ts'
import type {
  AdmittedChannel, Attempt, AuthEpoch, Effect, Event, Gen, Hold, Life, PendingView,
  ProcessLease, ReceiptEvent, Seq, StageName, StageResult, StepContext, Timing, Transition,
} from '../../../../packages/core/src/local/session-life/types.ts'

const seq = (value: number) => value as Seq
const G: Gen = { auth: 1 as AuthEpoch, attempt: 1 as Attempt }
const NEXT: Gen = { auth: 1 as AuthEpoch, attempt: 2 as Attempt }
const STALE: Gen = { auth: 0 as AuthEpoch, attempt: 1 as Attempt }
const CTX: StepContext = { next: NEXT }
const CAUSE = { name: 'StageRejected', message: 'fixture rejected before admission', code: 17 }
const EXIT = { cause: CAUSE, code: 1, signal: null }
const STOP = { reason: 'user-stop' as const, barrier: seq(10) }
const FAILED = { reason: 'start-failed' as const, barrier: seq(10), stage: 'platform' as const, cause: CAUSE }
const OUT = { reason: 'sign-out' as const, ownerUserId: 'owner', prior: null }

export function pending(queued: readonly number[] = [], dispatching: readonly number[] = []): PendingView {
  const rows = Object.freeze(queued.map(seq))
  const flights = Object.freeze(dispatching.map(seq))
  return Object.freeze({ queued: rows, dispatching: flights })
}

const output = (at: StageName, timing: Timing = 'next-tool-call'): StageResult => {
  switch (at) {
    case 'identity': return { at, value: { kind: 'bound', agentUserId: 'agent' } }
    case 'workspace': case 'capabilities': case 'platform': case 'cli': return { at, value: { kind: 'none' } }
    case 'process': return { at, value: Object.freeze({}) as ProcessLease }
    case 'channel': return { at, value: Object.freeze({ gen: G, timing }) as AdmittedChannel }
  }
}

function dormant(hold: Hold | null = null): Life { return hydrateLife({ hold, archived: false }) }
function archived(): Life { return hydrateLife({ hold: null, archived: true }) }
function starting(at: StageName = 'identity'): Life {
  let state = step(dormant(), { k: 'start', origin: 'user-open' }, pending(), { ...CTX, next: G })[0]
  for (const stage of STAGES) {
    if (stage === at) return state
    state = step(state, { k: 'stage-ok', gen: G, out: output(stage) }, pending(), CTX)[0]
  }
  throw new Error(`Unknown fixture stage ${at}`)
}
function ready(timing: Timing = 'next-tool-call', admission: 'free' | 'awaiting' | 'busy' = 'free'): Life {
  let state = step(starting('channel'), { k: 'stage-ok', gen: G, out: output('channel', timing) }, pending(), CTX)[0]
  if (admission === 'awaiting') state = step(state, { k: 'deliver', seq: seq(10) }, pending([10]), CTX)[0]
  if (admission === 'busy') state = step(state, { k: 'turn-busy', gen: G }, pending(), CTX)[0]
  return state
}
function stopping(reason: Extract<Event, { k: 'interrupt' }>['reason'] = 'version-switch'): Life {
  return step(ready(), interrupt(reason), pending([5]), CTX)[0]
}
function stoppingFailed(): Life {
  return step(starting('platform'), { k: 'stage-fail', gen: G, at: 'platform', cause: CAUSE }, pending([5]), CTX)[0]
}
function decide(state: Life, event: Event, q = pending()): Transition { return step(state, event, q, CTX) }
function kind(result: Transition, expected: Life['kind']): Life { assert.equal(result[0].kind, expected); return result[0] }
function effect(result: Transition, expected: Effect): void { assert.ok(result[1].some(e => JSON.stringify(e) === JSON.stringify(expected)), JSON.stringify({ effects: result[1], expected })) }
function noChange(state: Life, event: Event, q = pending()): void { assert.deepEqual(decide(state, event, q), [state, []]) }
const deliver: Event = { k: 'deliver', seq: seq(20) }
const start: Event = { k: 'start', origin: 'retry' }
const signedIn: Event = { k: 'signed-in', userId: 'owner' }
const interrupt = (reason: Extract<Event, { k: 'interrupt' }>['reason']): Event => reason === 'sign-out'
  ? { k: 'interrupt', reason, ownerUserId: 'owner' } : { k: 'interrupt', reason }
const accepted: Extract<ReceiptEvent, { result: 'accepted' }> = { k: 'receipt', gen: G, seq: seq(10), result: 'accepted', nativeReceiptId: 'native' }
const rejected: Extract<ReceiptEvent, { result: 'rejected-before-admission' }> = { k: 'receipt', gen: G, seq: seq(10), result: 'rejected-before-admission', nativeReceiptId: null, cause: CAUSE }
const lost: Extract<ReceiptEvent, { result: 'channel-lost' }> = { k: 'receipt', gen: G, seq: seq(10), result: 'channel-lost', nativeReceiptId: null, cause: CAUSE }

export const transitionCases: readonly { row: number; name: string; run: () => void }[] = [
  { row: 1, name: 'dormant delivery starts identity once', run() { kind(decide(dormant(), deliver, pending([20])), 'starting'); effect(decide(dormant(), deliver), { e: 'run-stage', gen: NEXT, at: 'identity', have: {} }) } },
  { row: 2, name: 'new delivery withdraws a user stop', run() { const r = decide(dormant(STOP), deliver, pending([20])); kind(r, 'starting'); effect(r, { e: 'write-hold', hold: null }) } },
  { row: 3, name: 'signed-out delivery stays queued', run() { noChange(dormant(OUT), deliver, pending([20])) } },
  { row: 4, name: 'explicit starts clear ordinary and failed holds', run() { for (const s of [dormant(), dormant(STOP), dormant(FAILED)]) { const r = decide(s, start); kind(r, 'starting'); effect(r, { e: 'write-hold', hold: null }) } } },
  { row: 5, name: 'a new delivery retries a failed start', run() { kind(decide(dormant(FAILED), deliver, pending([20])), 'starting') } },
  { row: 6, name: 'stopping a dormant session persists its barrier', run() { const r = decide(dormant(), interrupt('user-stop'), pending([10])); kind(r, 'dormant'); effect(r, { e: 'write-hold', hold: STOP }) } },
  { row: 7, name: 'a second user stop preserves its barrier', run() { noChange(dormant(STOP), interrupt('user-stop'), pending([20])) } },
  { row: 8, name: 'sign-out remembers the prior user stop', run() { for (const h of [null, STOP]) { const r = decide(dormant(h), interrupt('sign-out')); effect(r, { e: 'write-hold', hold: { ...OUT, prior: h } }) } } },
  { row: 9, name: 'repeated sign-out is an identity transition', run() { noChange(dormant(OUT), interrupt('sign-out')) } },
  { row: 10, name: 'reaping or replacing a non-running session does not start it', run() { for (const s of [dormant(), dormant(STOP), dormant(OUT), dormant(FAILED)]) for (const r of ['version-switch', 'idle-reap'] as const) noChange(s, interrupt(r)) } },
  { row: 11, name: 'failed keeps its cause through stop or sign-out', run() { for (const r of ['user-stop', 'sign-out'] as const) noChange(dormant(FAILED), interrupt(r)) } },
  { row: 12, name: 'archive fails every queued row and clears the hold', run() { for (const s of [dormant(), dormant(FAILED)]) { const r = decide(s, interrupt('archive'), pending([5, 10])); kind(r, 'archived'); assert.deepEqual(r[1].filter(e => e.e === 'write-receipt').map(e => e.seq), [5, 10]); effect(r, { e: 'write-hold', hold: null }) } } },
  { row: 13, name: 'delete emits removal for every non-running state', run() { for (const s of [dormant(), dormant(FAILED), archived()]) effect(decide(s, interrupt('delete')), { e: 'remove' }) } },
  { row: 14, name: 'same-account sign-in restores stop or pumps an unheld queue', run() { const r = decide(dormant({ ...OUT, prior: STOP }), signedIn, pending([5, 10])); kind(r, 'dormant'); effect(r, { e: 'write-hold', hold: STOP }); kind(decide(dormant({ ...OUT, prior: STOP }), signedIn, pending([20])), 'starting'); kind(decide(dormant(OUT), signedIn, pending([20])), 'starting'); kind(decide(dormant(OUT), signedIn), 'dormant') } },
  { row: 15, name: 'another account cannot release the sign-out hold', run() { noChange(dormant(OUT), { k: 'signed-in', userId: 'other' }, pending([20])) } },
  { row: 16, name: 'sign-in does not retry stopped failed or archived sessions', run() { for (const s of [dormant(), dormant(STOP), dormant(FAILED), archived()]) noChange(s, signedIn, pending([20])) } },
  { row: 17, name: 'starting coalesces more start and delivery commands', run() { for (const e of [deliver, start]) noChange(starting(), e, pending([20])) } },
  { row: 18, name: 'each stage accumulates all earlier outputs', run() { for (let i = 0; i < STAGES.length - 1; i++) { const at = STAGES[i]; const r = decide(starting(at), { k: 'stage-ok', gen: G, out: output(at) }); const s = kind(r, 'starting'); assert.ok(s.kind === 'starting'); assert.equal(s.progress.at, STAGES[i + 1]); assert.deepEqual(Object.keys(s.progress.have), STAGES.slice(0, i + 1)) } } },
  { row: 19, name: 'only the current channel proof admits and pumps the queue', run() { const r = decide(starting('channel'), { k: 'stage-ok', gen: G, out: output('channel') }, pending([20])); const s = kind(r, 'ready'); assert.ok(s.kind === 'ready'); assert.deepEqual(s.admission, { kind: 'awaiting', seq: 20 }); effect(r, { e: 'dispatch', gen: G, seq: seq(20) }) } },
  { row: 20, name: 'each startup failure exits through teardown and reports queued sources', run() { for (const at of STAGES) { const r = decide(starting(at), { k: 'stage-fail', gen: G, at, cause: CAUSE }, pending([5])); const s = kind(r, 'stopping'); assert.ok(s.kind === 'stopping' && s.destination.kind === 'held'); assert.deepEqual(s.destination.hold, { ...FAILED, barrier: seq(5), stage: at }); effect(r, { e: 'abort', gen: G }); effect(r, { e: 'report-failure', seqs: [seq(5)], cause: CAUSE }) } kind(decide(starting(), { k: 'exit', gen: G, exit: EXIT }), 'stopping') } },
  { row: 21, name: 'startup interruption withdraws then tears down its resources', run() { for (const reason of ['user-stop', 'sign-out', 'archive', 'delete', 'version-switch', 'idle-reap'] as const) { const r = decide(starting('process'), interrupt(reason)); kind(r, 'stopping'); assert.deepEqual(r[1].map(e => e.e), ['abort', 'teardown']) } } },
  { row: 22, name: 'a ready free session dispatches its actual queue head', run() { effect(decide(ready(), deliver, pending([20])), { e: 'dispatch', gen: G, seq: seq(20) }) } },
  { row: 23, name: 'a second delivery cannot bypass an in-flight receipt or busy leg', run() { for (const s of [ready('idle-only', 'awaiting'), ready('idle-only', 'busy')]) noChange(s, deliver, pending([20])) } },
  { row: 24, name: 'start is idempotent once ready', run() { noChange(ready(), start) } },
  { row: 25, name: 'accepted alone marks read and either pumps or waits for idle', run() { const r = decide(ready('next-tool-call', 'awaiting'), accepted, pending([20])); assert.deepEqual(r[1].map(e => e.e), ['write-receipt', 'mark-source-read', 'dispatch']); const s = kind(decide(ready('idle-only', 'awaiting'), accepted, pending([20])), 'ready'); assert.ok(s.kind === 'ready'); assert.equal(s.admission.kind, 'busy') } },
  { row: 26, name: 'a rejected head fails visibly and dispatches the next row', run() { const r = decide(ready('next-tool-call', 'awaiting'), rejected, pending([20])); assert.deepEqual(r[1].map(e => e.e), ['write-receipt', 'report-failure', 'dispatch']); effect(r, { e: 'dispatch', gen: G, seq: seq(20) }) } },
  { row: 27, name: 'a manual turn closes idle-only admission without copying Activity', run() { const s = kind(decide(ready('idle-only'), { k: 'turn-busy', gen: G }), 'ready'); assert.ok(s.kind === 'ready'); assert.equal(s.admission.kind, 'busy'); assert.equal('activity' in s, false) } },
  { row: 28, name: 'turn-busy does not erase the outstanding admission identity', run() { for (const a of ['awaiting', 'busy'] as const) noChange(ready('idle-only', a), { k: 'turn-busy', gen: G }) } },
  { row: 29, name: 'turn-idle pumps a held idle-only queue', run() { effect(decide(ready('idle-only', 'busy'), { k: 'turn-idle', gen: G }, pending([20])), { e: 'dispatch', gen: G, seq: seq(20) }) } },
  { row: 30, name: 'idle while free or awaiting preserves the current admission', run() { for (const a of ['free', 'awaiting'] as const) noChange(ready('idle-only', a), { k: 'turn-idle', gen: G }) } },
  { row: 10, name: 'v3.2: reconfigure is the way out of a failure: leftovers torn down, the session rests for the new start', run() { assert.equal(dormant(FAILED).kind, 'failed'); const r = decide(dormant(FAILED), interrupt('reconfigure')); kind(r, 'dormant'); effect(r, { e: 'write-hold', hold: null }); for (const reason of ['user-stop', 'sign-out', 'version-switch', 'idle-reap'] as const) noChange(dormant(FAILED), interrupt(reason)) } },
  { row: 20, name: 'N4: a retry of a failed batch does not tell its rows again; a row after the failure is told', run() {
    const retry = decide(dormant(FAILED), start, pending([5, 10, 20])); const s = kind(retry, 'starting'); assert.ok(s.kind === 'starting'); assert.equal(s.told, seq(10))
    const failedAgain = decide(s, { k: 'stage-fail', gen: NEXT, at: 'identity', cause: CAUSE }, pending([5, 10, 20]))
    effect(failedAgain, { e: 'report-failure', seqs: [seq(20)], cause: CAUSE })
    const nothingNew = decide(s, { k: 'stage-fail', gen: NEXT, at: 'identity', cause: CAUSE }, pending([5, 10]))
    assert.equal(nothingNew[1].some(e => e.e === 'report-failure'), false)
  } },
  { row: 26, name: '#552: a channel lost before admission puts the head back and restarts for it, tearing down first', run() { const s = ready('next-tool-call', 'awaiting'); const r = decide(s, lost, pending([20], [10])); kind(r, 'starting'); assert.deepEqual(r[1].map(e => e.e), ['write-receipt', 'teardown', 'run-stage']); effect(r, { e: 'write-receipt', seq: seq(10), receipt: { state: 'queued', channelLost: CAUSE } }); assert.equal(r[1].some(e => e.e === 'report-failure'), false) } },
  { row: 43, name: '#552: during teardown a lost channel only puts the row back; settle decides by destination', run() { const s = stopping('user-stop'); const r = decide(s, lost); assert.equal(r[0], s); assert.deepEqual(r[1], [{ e: 'write-receipt', seq: seq(10), receipt: { state: 'queued', channelLost: CAUSE } }]) } },
  { row: 31, name: 'exit makes the in-flight row unknown and tears down before a next attempt', run() { const s = ready('next-tool-call', 'awaiting'); const r = decide(s, { k: 'exit', gen: G, exit: EXIT }, pending([20], [10])); kind(r, 'starting'); assert.deepEqual(r[1].map(e => e.e), ['write-receipt', 'report-failure', 'teardown', 'run-stage']); effect(r, { e: 'write-receipt', seq: seq(10), receipt: { state: 'unknown' } }); effect(r, { e: 'report-failure', seqs: [seq(10)], cause: OUTCOME_UNKNOWN }); assert.ok(s.kind === 'ready'); effect(r, { e: 'teardown', gen: G, have: s.have }); const empty = decide(ready(), { k: 'exit', gen: G, exit: EXIT }); const dormantState = kind(empty, 'dormant'); assert.ok(dormantState.kind === 'dormant'); assert.deepEqual(dormantState.lastExit, EXIT); assert.deepEqual(empty[1].map(e => e.e), ['teardown']) } },
  { row: 32, name: 'a genuinely free empty session may be reaped', run() { kind(decide(ready(), interrupt('idle-reap')), 'stopping') } },
  { row: 33, name: 'stale reaper observations are explicit no-ops', run() { noChange(ready(), interrupt('idle-reap'), pending([20])); for (const a of ['awaiting', 'busy'] as const) noChange(ready('idle-only', a), interrupt('idle-reap')) } },
  { row: 34, name: 'ready interruptions retain the complete teardown lease', run() { const s = ready(); const r = decide(s, interrupt('archive')); kind(r, 'stopping'); assert.ok(s.kind === 'ready'); effect(r, { e: 'teardown', gen: G, have: s.have }) } },
  { row: 35, name: 'hold or archive interrupts erase an earlier wake intent', run() { let s = decide(stopping(), start)[0]; const h = decide(s, interrupt('sign-out'))[0]; assert.ok(h.kind === 'stopping'); assert.deepEqual(h.destination, { kind: 'held', hold: OUT }); s = decide(h, interrupt('archive'))[0]; s = decide(s, interrupt('user-stop'))[0]; assert.ok(s.kind === 'stopping'); assert.deepEqual(s.destination, { kind: 'archived' }); s = decide(s, interrupt('delete'))[0]; assert.ok(s.kind === 'stopping'); assert.deepEqual(s.destination, { kind: 'deleted' }) } },
  { row: 36, name: 'delivery during archive or delete gets a failure receipt', run() { for (const reason of ['archive', 'delete'] as const) { const r = decide(stopping(reason), deliver); assert.equal(r[1][0]?.e, 'write-receipt'); assert.equal(r[1].some(e => e.e === 'dispatch'), false) } } },
  { row: 37, name: 'delivery or start during rest requests one later wake', run() { for (const e of [deliver, start]) { const s = decide(stopping(), e)[0]; assert.ok(s.kind === 'stopping'); assert.deepEqual(s.destination, { kind: 'rest', wakeAfter: true }) } } },
  { row: 38, name: 'held delivery remains data for the barrier decision', run() { for (const s of [stopping('user-stop'), stoppingFailed(), stopping('sign-out')]) noChange(s, deliver, pending([20])) } },
  { row: 39, name: 'explicit start may withdraw a user or startup-failure hold', run() { for (const s of [stopping('user-stop'), stoppingFailed()]) { const n: Life = decide(s, start)[0]; assert.ok(n.kind === 'stopping'); assert.deepEqual(n.destination, { kind: 'rest', wakeAfter: true }) } } },
  { row: 40, name: 'start cannot release sign-out archive or delete', run() { for (const r of ['sign-out', 'archive', 'delete'] as const) noChange(stopping(r), start) } },
  { row: 41, name: 'late same-generation stage outputs are torn down individually', run() { for (const at of STAGES) { const out = output(at); const r = decide(stopping('user-stop'), { k: 'stage-ok', gen: G, out }); assert.deepEqual(r[1], [{ e: 'teardown', gen: G, have: { [out.at]: out.value } }]) } } },
  { row: 42, name: 'exit failure and turn observations do not change a stop destination', run() { const s = stopping('archive'); for (const e of [{ k: 'exit', gen: G, exit: EXIT }, { k: 'stage-fail', gen: G, at: 'identity', cause: CAUSE }, { k: 'turn-busy', gen: G }, { k: 'turn-idle', gen: G }] as const) noChange(s, e) } },
  { row: 43, name: 'old-epoch receipts settle during teardown and accepted alone marks read', run() { const s = stopping('sign-out'); for (const e of [accepted, rejected]) { const r = decide(s, e); assert.equal(r[0], s); assert.equal(r[1].some(x => x.e === 'mark-source-read'), e.result === 'accepted') } } },
  { row: 44, name: 'settled uses destination and durable barriers and closes dispatching as unknown', run() { const settled: Event = { k: 'settled', gen: G }; for (const s of [stopping('user-stop'), stoppingFailed()]) { const old = decide(s, settled, pending([5], [10])); assert.ok(old[0].kind === 'dormant' || old[0].kind === 'failed'); effect(old, { e: 'write-receipt', seq: seq(10), receipt: { state: 'unknown' } }); kind(decide(s, settled, pending([20])), 'starting') } kind(decide(stopping('sign-out'), settled, pending([20])), 'dormant'); kind(decide(stopping('archive'), settled, pending([20])), 'archived'); effect(decide(stopping('delete'), settled), { e: 'remove' }); kind(decide(decide(stopping(), start)[0], settled), 'starting'); kind(decide(stopping(), settled), 'dormant') } },
  { row: 45, name: 'archived delivery can only fail the new row', run() { const s = archived(); const r = decide(s, deliver); assert.equal(r[0], s); assert.deepEqual(r[1].map(e => e.e), ['write-receipt']) } },
  { row: 46, name: 'restore clears archive without auto-starting', run() { kind(decide(archived(), { k: 'restore' }, pending([20])), 'dormant') } },
  { row: 47, name: 'archive absorbs starts and every non-delete interruption', run() { const s = archived(); noChange(s, start); for (const r of ['user-stop', 'sign-out', 'archive', 'version-switch', 'idle-reap'] as const) noChange(s, interrupt(r)) } },
]

export const invariantCases: readonly { name: string; run: () => void }[] = [
  { name: 'hydration and settled use the identical barrier predicate', run() { for (const h of [STOP, FAILED]) { assert.equal(shouldStartOnHydrate(dormant(h), pending([5, 10])), false); assert.equal(shouldStartOnHydrate(dormant(h), pending([20])), true) } assert.equal(shouldStartOnHydrate(dormant(OUT), pending([20])), false); assert.equal(shouldStartOnHydrate(archived(), pending([20])), false); assert.equal(shouldStartOnHydrate(dormant(), pending([20])), true) } },
  { name: 'channel readiness cannot be forged from a stale proof in a current completion', run() { assert.throws(() => decide(starting('channel'), { k: 'stage-ok', gen: G, out: { at: 'channel', value: { gen: STALE, timing: 'next-tool-call' } as AdmittedChannel } }), LifeProtocolError) } },
  { name: 'all seven stage completions reject the other six current-generation stages', run() { for (const at of STAGES) for (const other of STAGES) if (at !== other) assert.throws(() => decide(starting(at), { k: 'stage-ok', gen: G, out: output(other) }), LifeProtocolError) } },
  { name: 'a wake followed by sign-out cannot start while signing out', run() { const wake = decide(stopping(), deliver, pending([20]))[0]; const out = decide(wake, interrupt('sign-out'), pending([20]))[0]; const r = decide(out, { k: 'settled', gen: G }, pending([20])); kind(r, 'dormant'); assert.equal(r[1].some(e => e.e === 'run-stage'), false) } },
  { name: 'v3.1 #13: reconfigure stops like a version switch (no barrier) and a reconfigure start follows', run() {
    const s = decide(ready(), interrupt('reconfigure'))[0]; assert.ok(s.kind === 'stopping'); assert.deepEqual(s.destination, { kind: 'rest', wakeAfter: false })
    kind(decide(s, { k: 'settled', gen: G }), 'dormant'); kind(decide(decide(s, { k: 'settled', gen: G })[0], { k: 'start', origin: 'reconfigure' }), 'starting')
    noChange(dormant(), interrupt('reconfigure'))
  } },
  { name: 'only entering archived or deleted ends the dependents', run() {
    const ends = (t: Transition) => t[1].some(e => e.e === 'end-dependents')
    for (const s of [dormant(), dormant(FAILED)]) for (const r of ['archive', 'delete'] as const) assert.equal(ends(decide(s, interrupt(r), pending([20]))), true)
    for (const r of ['archive', 'delete'] as const) assert.equal(ends(decide(stopping(r), { k: 'settled', gen: G }, pending([20]))), true)
    for (const s of [stopping('user-stop'), stopping('version-switch'), stopping('sign-out')]) assert.equal(ends(decide(s, { k: 'settled', gen: G }, pending([20]))), false)
    assert.equal(ends(decide(ready(), { k: 'exit', gen: G, exit: EXIT }, pending([20]))), false)
    assert.equal(ends(decide(ready(), interrupt('idle-reap'))), false)
  } },
  { name: 'sign-out outranks a startup-failure hold (v3.1 #7)', run() { const s = decide(stoppingFailed(), interrupt('sign-out'))[0]; assert.ok(s.kind === 'stopping'); assert.deepEqual(s.destination, { kind: 'held', hold: OUT }); kind(decide(s, { k: 'settled', gen: G }, pending([20])), 'dormant') } },
  { name: 'v3.1 #9: a current-run fault fails every live state; in-flight rows become unknown, queued rows stay', run() {
    for (const s of [starting('cli'), ready('next-tool-call', 'awaiting'), stopping('user-stop')]) {
      const r = decide(s, { k: 'fault', run: G, cause: CAUSE, unreleased: null }, pending([20], [10]))
      const f = kind(r, 'failed'); assert.ok(f.kind === 'failed' && f.hold.reason === 'effect-fault' && f.residue[0]?.gen === G)
      assert.deepEqual(r[1], [{ e: 'write-receipt', seq: seq(10), receipt: { state: 'unknown' } }, { e: 'report-failure', seqs: [seq(10)], cause: OUTCOME_UNKNOWN }, { e: 'write-hold', hold: { reason: 'effect-fault', barrier: seq(20), cause: CAUSE } }])
      noChange(s, { k: 'fault', run: STALE, cause: CAUSE, unreleased: null }, pending([20], [10])); noChange(s, { k: 'fault', run: null, cause: CAUSE, unreleased: null })
    }
    const d = decide(dormant(), { k: 'fault', run: null, cause: CAUSE, unreleased: null }, pending([20])); kind(d, 'failed'); assert.equal(d[1].some(e => e.e === 'write-receipt'), false)
    noChange(dormant(), { k: 'fault', run: G, cause: CAUSE, unreleased: null }); noChange(archived(), { k: 'fault', run: null, cause: CAUSE, unreleased: null })
    // A teardown that threw after ready×exit already went dormant: its resources survive as residue for the retry.
    const leftover = { gen: G, have: (ready() as Extract<Life, { kind: 'ready' }>).have }
    const u = decide(dormant(), { k: 'fault', run: null, cause: CAUSE, unreleased: leftover })[0]
    assert.ok(u.kind === 'failed'); assert.deepEqual(u.residue, [leftover]); assert.deepEqual(decide(u, start)[1][0], { e: 'teardown', ...leftover })
  } },
  { name: 'v3.1 #9: a faulted run is torn down before a retry, an archive or a delete; the failed batch does not retry itself', run() {
    const f = decide(ready(), { k: 'fault', run: G, cause: CAUSE, unreleased: null }, pending([20]))[0]
    for (const e of [start, deliver] as const) { const r = decide(f, e, pending([20])); kind(r, 'starting'); assert.equal(r[1][0]?.e, 'teardown'); assert.deepEqual(r[1][0], { e: 'teardown', gen: G, have: (ready() as Extract<Life, { kind: 'ready' }>).have }) }
    assert.equal(decide(f, interrupt('archive'), pending([20]))[1][0]?.e, 'teardown')
    assert.deepEqual(decide(f, interrupt('delete'))[1].map(e => e.e), ['teardown', 'end-dependents', 'remove'])
    assert.equal(shouldStartOnHydrate(hydrateLife({ archived: false, hold: { reason: 'effect-fault', barrier: seq(20), cause: CAUSE } }), pending([20])), false)
    kind([hydrateLife({ archived: false, hold: { reason: 'effect-fault', barrier: seq(20), cause: CAUSE } }), []], 'failed')
  } },
  { name: 'a late stop cannot undo archive or delete', run() { for (const reason of ['archive', 'delete'] as const) { const s = decide(stopping(reason), interrupt('user-stop'))[0]; assert.ok(s.kind === 'stopping'); assert.equal(s.destination.kind, reason === 'archive' ? 'archived' : 'deleted') } } },
  { name: 'a null barrier means any durable queued row is later and unknown rows never count as queued', run() { assert.equal(shouldStartOnHydrate(dormant({ ...STOP, barrier: null }), pending([1])), true); assert.equal(shouldStartOnHydrate(dormant({ ...STOP, barrier: null }), pending([], [1])), false); const r = decide(stopping('sign-out'), { k: 'settled', gen: G }, pending([], [1])); assert.equal(r[1].filter(e => e.e === 'write-receipt').every(e => e.receipt.state === 'unknown'), true); assert.equal(r[1].some(e => e.e === 'mark-source-read'), false) } },
  { name: 'version-switch settlement and reconstruction both resume an existing queue', run() {
    const runningState = ready()
    for (const rows of [[], [5], [5, 20]]) {
      const q = pending(rows)
      const stoppingState = decide(runningState, interrupt('version-switch'), q)[0]
      const online = decide(stoppingState, { k: 'settled', gen: G }, q)
      assert.equal(online[0].kind === 'starting', shouldStartOnHydrate(dormant(), q))
      assert.equal(online[1].some(e => e.e === 'run-stage'), rows.length > 0)
    }
  } },
  { name: 'barriers derive from both row sets and a failed batch never retries itself', run() {
    const q = pending([5, 20], [10, 30])
    const stopped = decide(ready(), interrupt('user-stop'), q)[0]
    assert.ok(stopped.kind === 'stopping' && stopped.destination.kind === 'held')
    assert.deepEqual(stopped.destination.hold, { ...STOP, barrier: seq(30) })
    for (const at of STAGES) {
      const failed = decide(starting(at), { k: 'stage-fail', gen: G, at, cause: CAUSE }, q)[0]
      assert.ok(failed.kind === 'stopping' && failed.destination.kind === 'held')
      const hold = failed.destination.hold
      assert.equal('barrier' in hold && hold.barrier, 30)
      for (const rows of [[5, 20], [5, 20, 31]]) {
        const snapshot = pending(rows)
        const online = decide(failed, { k: 'settled', gen: G }, snapshot)
        const hydrated = dormant(hold)
        assert.equal(online[0].kind === 'starting', shouldStartOnHydrate(hydrated, snapshot))
        assert.equal(online[0].kind === 'starting', rows.includes(31))
      }
    }
  } },
  { name: 'sign-in restores the prior stop and applies the same durable barrier predicate', run() {
    for (const prior of [null, STOP]) for (const rows of [[], [5, 10], [5, 20]]) {
      const q = pending(rows)
      const result = decide(dormant({ ...OUT, prior }), signedIn, q)
      assert.equal(result[0].kind === 'starting', shouldStartOnHydrate(dormant(prior), q))
      assert.equal(result[1].some(e => e.e === 'run-stage'), shouldStartOnHydrate(dormant(prior), q))
    }
  } },
  { name: 'the adapter channel is the only timing source and Life carries no wall clock', run() {
    for (const at of STAGES) {
      const state = starting(at)
      assert.ok(state.kind === 'starting')
      assert.equal('since' in state.progress, false)
    }
    for (const timing of ['next-tool-call', 'idle-only'] as const) {
      const state = ready(timing, 'awaiting')
      assert.ok(state.kind === 'ready')
      assert.equal('timing' in state, false)
      assert.equal(state.have.channel.timing, timing)
      const admitted = decide(state, accepted, pending([20]))[0]
      assert.ok(admitted.kind === 'ready')
      assert.equal(admitted.admission.kind, timing === 'idle-only' ? 'busy' : 'awaiting')
    }
  } },
]

export function verifyAllCases(): void {
  assert.deepEqual(transitionCases.map(c => c.row), Array.from({ length: 47 }, (_, i) => i + 1))
  for (const c of transitionCases) c.run()
  for (const c of invariantCases) c.run()
  verifyMatrix()
}

/** An independent domain table covers every Event kind, both generation fields, and every Life variant. */
export function verifyMatrix(): void {
  const states: { name: string; state: Life }[] = [
    { name: 'dormant', state: dormant() }, { name: 'user-stop', state: dormant(STOP) },
    { name: 'signed-out', state: dormant(OUT) }, { name: 'failed', state: dormant(FAILED) },
    ...STAGES.map(at => ({ name: `starting-${at}`, state: starting(at) })),
    ...(['next-tool-call', 'idle-only'] as const).flatMap(timing => (['free', 'awaiting'] as const).map(a => ({ name: `ready-${timing}-${a}`, state: ready(timing, a) }))),
    { name: 'ready-idle-only-busy', state: ready('idle-only', 'busy') },
    ...(['user-stop', 'sign-out', 'archive', 'delete', 'version-switch'] as const).map(r => ({ name: `stopping-${r}`, state: stopping(r) })),
    { name: 'stopping-start-failed', state: stoppingFailed() }, { name: 'archived', state: archived() },
  ]
  const events: Event[] = [deliver, start, ...STAGES.map(at => ({ k: 'stage-ok' as const, gen: G, out: output(at) })),
    ...STAGES.map(at => ({ k: 'stage-fail' as const, gen: G, at, cause: CAUSE })), accepted, rejected, lost,
    { ...accepted, seq: seq(99) }, { k: 'turn-busy', gen: G }, { k: 'turn-idle', gen: G }, { k: 'exit', gen: G, exit: EXIT },
    ...(['user-stop', 'sign-out', 'archive', 'delete', 'version-switch', 'idle-reap', 'reconfigure'] as const).map(interrupt),
    { k: 'settled', gen: G }, { k: 'restore' }, signedIn, { k: 'signed-in', userId: 'other' },
    { k: 'fault', run: G, cause: CAUSE, unreleased: null }, { k: 'fault', run: null, cause: CAUSE, unreleased: null }, { k: 'fault', run: STALE, cause: CAUSE, unreleased: null }]
  for (const { name, state: s } of states) for (const e of events) {
    if ('gen' in e && (s.kind === 'dormant' || s.kind === 'failed' || s.kind === 'archived')) {
      assert.deepEqual(decide(s, e), [s, []], name)
      continue
    }
    let legal: boolean
    switch (s.kind) {
      case 'dormant': legal = e.k === 'fault' || e.k === 'deliver' || e.k === 'signed-in' || (e.k === 'start' && s.hold?.reason !== 'sign-out') || (e.k === 'interrupt' && !(s.hold?.reason === 'sign-out' && e.reason === 'user-stop')); break
      case 'failed': legal = e.k === 'fault' || e.k === 'deliver' || e.k === 'start' || e.k === 'interrupt' || e.k === 'signed-in'; break
      case 'starting': legal = e.k === 'fault' || e.k === 'deliver' || e.k === 'start' || e.k === 'interrupt' || e.k === 'exit' || (e.k === 'stage-ok' && e.out.at === s.progress.at) || (e.k === 'stage-fail' && e.at === s.progress.at); break
      case 'ready': legal = e.k === 'fault' || e.k === 'deliver' || e.k === 'start' || e.k === 'interrupt' || e.k === 'exit' || (e.k === 'receipt' && s.admission.kind === 'awaiting' && s.admission.seq === e.seq) || ((e.k === 'turn-busy' || e.k === 'turn-idle') && s.have.channel.timing === 'idle-only'); break
      case 'stopping': legal = e.k !== 'restore' && e.k !== 'signed-in'; break
      case 'archived': legal = e.k === 'fault' || e.k === 'deliver' || e.k === 'start' || e.k === 'interrupt' || e.k === 'restore' || e.k === 'signed-in'; break
    }
    if (legal) decide(s, e, pending([20], [10]))
    else assert.throws(() => decide(s, e, pending([20], [10])), LifeProtocolError, `${name} × ${e.k}`)
    if ('gen' in e) {
      for (const gen of [STALE, { ...G, attempt: 0 as Attempt }]) assert.deepEqual(decide(s, { ...e, gen }, pending([20], [10])), [s, []], `${name} stale ${e.k}`)
    }
  }
}
