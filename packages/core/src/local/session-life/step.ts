import type {
  Destination, Effect, Event, Gen, Hold, Interrupt, Life, LifeShape, PendingView,
  Progress, ReceiptEvent, Seq, StageResult, StepContext, Transition,
} from './types.ts'

export class LifeProtocolError extends Error {
  readonly state: Life['kind']
  readonly event: Event['k']
  constructor(state: Life['kind'], event: Event['k']) {
    super(`Session lifecycle protocol violation: ${state} × ${event}`)
    this.name = 'LifeProtocolError'
    this.state = state
    this.event = event
  }
}

function assertNever(value: never): never {
  throw new Error(`Unreachable session lifecycle discriminant: ${String(value)}`)
}

// Only this module seals lifecycle values. Hydration can only construct non-running states.
function seal(value: LifeShape): Life { return value as Life }
function unchanged(state: Life): Transition { return [state, []] }
function protocol(state: Life, event: Event): never { throw new LifeProtocolError(state.kind, event.k) }

export function hydrateLife(input: { readonly archived: boolean; readonly hold: Hold | null }): Life {
  if (input.archived) return seal({ kind: 'archived' })
  if (input.hold?.reason === 'start-failed') return seal({ kind: 'failed', hold: input.hold })
  return seal({ kind: 'dormant', hold: input.hold, lastExit: null })
}

function sameGen(a: Gen | null, b: Gen | null): boolean {
  return a === null || b === null ? a === b : a.auth === b.auth && a.attempt === b.attempt
}

function afterBarrier(q: PendingView, barrier: Seq | null): boolean {
  return q.queued().some(seq => barrier === null || seq > barrier)
}

/** The same durable predicate is used after teardown and after a crash before deliver was stepped. */
export function shouldStartOnHydrate(state: Life, q: PendingView): boolean {
  switch (state.kind) {
    case 'failed': return afterBarrier(q, state.hold.barrier)
    case 'dormant':
      if (state.hold === null) return q.head() !== null
      return state.hold.reason === 'user-stop' && afterBarrier(q, state.hold.barrier)
    case 'starting':
    case 'ready':
    case 'stopping':
    case 'archived': return false
    default: return assertNever(state)
  }
}

function running(gen: Gen, progress: Progress): Transition {
  const { since: _since, ...stage } = progress
  return [seal({ kind: 'starting', gen, progress }), [{ e: 'run-stage', gen, ...stage }]]
}

function start(ctx: StepContext, clearHold: boolean): Transition {
  const [next, effects] = running(ctx.next, { at: 'identity', have: {}, since: ctx.since })
  return [next, clearHold ? [{ e: 'write-hold', hold: null }, ...effects] : effects]
}

function archivedRows(q: PendingView): Effect[] {
  return q.queued().map(seq => ({
    e: 'write-receipt', seq,
    receipt: { state: 'failed', cause: { name: 'SessionArchived', message: 'Session is archived' } },
  }))
}

function destination(reason: Interrupt, q: PendingView, ctx: StepContext): Destination {
  switch (reason) {
    case 'user-stop': return { kind: 'held', hold: { reason: 'user-stop', barrier: q.maxSeq() } }
    case 'sign-out': return { kind: 'held', hold: { reason: 'sign-out', ownerUserId: ctx.ownerUserId, prior: null } }
    case 'archive': return { kind: 'archived' }
    case 'delete': return { kind: 'deleted' }
    case 'version-switch':
    case 'idle-reap': return { kind: 'rest', wakeAfter: false }
    default: return assertNever(reason)
  }
}

function tighten(current: Destination, reason: Interrupt, q: PendingView, ctx: StepContext): Destination {
  switch (current.kind) {
    case 'rest':
      return reason === 'version-switch' || reason === 'idle-reap' ? current : destination(reason, q, ctx)
    case 'held':
      if (reason === 'archive' || reason === 'delete') return destination(reason, q, ctx)
      if (current.hold.reason === 'user-stop' && reason === 'sign-out') {
        return { kind: 'held', hold: { reason: 'sign-out', ownerUserId: ctx.ownerUserId, prior: current.hold } }
      }
      return current
    case 'archived': return reason === 'delete' ? { kind: 'deleted' } : current
    case 'deleted': return current
    default: return assertNever(current)
  }
}

function pump(state: Extract<LifeShape, { kind: 'ready' }>, q: PendingView): Transition {
  const seq = q.head()
  return [seal({ ...state, admission: seq === null ? { kind: 'free' } : { kind: 'awaiting', seq } }),
    seq === null ? [] : [{ e: 'dispatch', gen: state.gen, seq }]]
}

function receiptEffects(event: ReceiptEvent): Effect[] {
  return event.result === 'accepted'
    ? [{ e: 'write-receipt', seq: event.seq, receipt: { state: 'accepted', nativeReceiptId: event.nativeReceiptId } },
      { e: 'mark-source-read', seq: event.seq }]
    : [{ e: 'write-receipt', seq: event.seq, receipt: { state: 'failed', cause: event.cause } }]
}

function advance(state: Extract<Life, { kind: 'starting' }>, out: StageResult, q: PendingView, ctx: StepContext): Transition {
  const p = state.progress
  // Both discriminants are checked: a current-generation completion for the wrong stage is a protocol error.
  switch (p.at) {
    case 'identity':
      if (out.at !== 'identity') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'workspace', have: { identity: out.value }, since: ctx.since })
    case 'workspace':
      if (out.at !== 'workspace') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'capabilities', have: { ...p.have, workspace: out.value }, since: ctx.since })
    case 'capabilities':
      if (out.at !== 'capabilities') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'platform', have: { ...p.have, capabilities: out.value }, since: ctx.since })
    case 'platform':
      if (out.at !== 'platform') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'cli', have: { ...p.have, platform: out.value }, since: ctx.since })
    case 'cli':
      if (out.at !== 'cli') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'process', have: { ...p.have, cli: out.value }, since: ctx.since })
    case 'process':
      if (out.at !== 'process') throw new LifeProtocolError(state.kind, 'stage-ok')
      return running(state.gen, { at: 'channel', have: { ...p.have, process: out.value }, since: ctx.since })
    case 'channel':
      if (out.at !== 'channel' || !sameGen(out.value.gen, state.gen)) throw new LifeProtocolError(state.kind, 'stage-ok')
      return pump({ kind: 'ready', gen: state.gen, have: { ...p.have, channel: out.value }, timing: ctx.timing, admission: { kind: 'free' } }, q)
    default: return assertNever(p)
  }
}

function stepDormant(state: Extract<Life, { kind: 'dormant' }>, event: Event, q: PendingView, ctx: StepContext): Transition {
  switch (event.k) {
    case 'deliver': return state.hold?.reason === 'sign-out' ? unchanged(state) : start(ctx, state.hold !== null)
    case 'start':
      if (state.hold?.reason === 'sign-out') return protocol(state, event)
      return start(ctx, true)
    case 'interrupt':
      switch (event.reason) {
        case 'user-stop': {
          if (state.hold?.reason === 'sign-out') return protocol(state, event)
          if (state.hold) return unchanged(state)
          const hold = { reason: 'user-stop' as const, barrier: q.maxSeq() }
          return [seal({ ...state, hold }), [{ e: 'write-hold', hold }]]
        }
        case 'sign-out': {
          if (state.hold?.reason === 'sign-out') return unchanged(state)
          const hold = { reason: 'sign-out' as const, ownerUserId: ctx.ownerUserId, prior: state.hold }
          return [seal({ ...state, hold }), [{ e: 'write-hold', hold }]]
        }
        case 'archive': return [seal({ kind: 'archived' }), [...archivedRows(q), { e: 'write-hold', hold: null }]]
        case 'delete': return [seal({ kind: 'archived' }), [{ e: 'remove' }]]
        case 'version-switch':
        case 'idle-reap': return unchanged(state)
        default: return assertNever(event.reason)
      }
    case 'signed-in': {
      const hold = state.hold
      if (hold?.reason !== 'sign-out' || hold.ownerUserId !== event.userId) return unchanged(state)
      if (hold.prior) return [seal({ ...state, hold: hold.prior }), [{ e: 'write-hold', hold: hold.prior }]]
      return q.head() === null
        ? [seal({ ...state, hold: null }), [{ e: 'write-hold', hold: null }]]
        : start(ctx, true)
    }
    case 'stage-ok': case 'stage-fail': case 'receipt': case 'turn-busy': case 'turn-idle': case 'exit': case 'settled': case 'restore':
      return protocol(state, event)
    default: return assertNever(event)
  }
}

function stepFailed(state: Extract<Life, { kind: 'failed' }>, event: Event, q: PendingView, ctx: StepContext): Transition {
  switch (event.k) {
    case 'deliver': case 'start': return start(ctx, true)
    case 'interrupt':
      switch (event.reason) {
        case 'archive': return [seal({ kind: 'archived' }), [...archivedRows(q), { e: 'write-hold', hold: null }]]
        case 'delete': return [seal({ kind: 'archived' }), [{ e: 'remove' }]]
        case 'user-stop': case 'sign-out': case 'version-switch': case 'idle-reap': return unchanged(state)
        default: return assertNever(event.reason)
      }
    case 'signed-in': return unchanged(state)
    case 'stage-ok': case 'stage-fail': case 'receipt': case 'turn-busy': case 'turn-idle': case 'exit': case 'settled': case 'restore':
      return protocol(state, event)
    default: return assertNever(event)
  }
}

function stepStarting(state: Extract<Life, { kind: 'starting' }>, event: Event, q: PendingView, ctx: StepContext): Transition {
  switch (event.k) {
    case 'deliver': case 'start': return unchanged(state)
    case 'stage-ok': return advance(state, event.out, q, ctx)
    case 'stage-fail': case 'exit': {
      if (event.k === 'stage-fail' && event.at !== state.progress.at) return protocol(state, event)
      const cause = event.k === 'exit' ? event.exit.cause : event.cause
      return [seal({ kind: 'stopping', gen: state.gen, have: state.progress.have,
        destination: { kind: 'held', hold: { reason: 'start-failed', barrier: q.maxSeq(), stage: state.progress.at, cause } } }),
      [{ e: 'abort', gen: state.gen }, { e: 'teardown', gen: state.gen, have: state.progress.have },
        { e: 'report-failure', seqs: q.queued(), cause }]]
    }
    case 'interrupt': return [seal({ kind: 'stopping', gen: state.gen, have: state.progress.have, destination: destination(event.reason, q, ctx) }),
      [{ e: 'abort', gen: state.gen }, { e: 'teardown', gen: state.gen, have: state.progress.have }]]
    case 'receipt': case 'turn-busy': case 'turn-idle': case 'settled': case 'restore': case 'signed-in':
      return protocol(state, event)
    default: return assertNever(event)
  }
}

function stepReady(state: Extract<Life, { kind: 'ready' }>, event: Event, q: PendingView, ctx: StepContext): Transition {
  switch (event.k) {
    case 'deliver':
      if (state.admission.kind !== 'free') return unchanged(state)
      if (q.head() === null) return protocol(state, event)
      return pump(state, q)
    case 'start': return unchanged(state)
    case 'receipt': {
      if (state.admission.kind !== 'awaiting' || state.admission.seq !== event.seq) return protocol(state, event)
      const effects = receiptEffects(event)
      if (event.result === 'accepted' && state.timing === 'idle-only') {
        return [seal({ ...state, admission: { kind: 'busy' } }), effects]
      }
      if (event.result === 'rejected-before-admission') effects.push({ e: 'report-failure', seqs: [event.seq], cause: event.cause })
      const [next, dispatch] = pump(state, q)
      return [next, [...effects, ...dispatch]]
    }
    case 'turn-busy':
      if (state.timing !== 'idle-only') return protocol(state, event)
      return state.admission.kind === 'free' ? [seal({ ...state, admission: { kind: 'busy' } }), []] : unchanged(state)
    case 'turn-idle':
      if (state.timing !== 'idle-only') return protocol(state, event)
      return state.admission.kind === 'busy' ? pump(state, q) : unchanged(state)
    case 'exit': {
      const effects: Effect[] = state.admission.kind === 'awaiting'
        ? [{ e: 'write-receipt', seq: state.admission.seq, receipt: { state: 'unknown' } }] : []
      if (q.head() === null) return [seal({ kind: 'dormant', hold: null, lastExit: event.exit }), effects]
      const [next, run] = start(ctx, false)
      return [next, [...effects, ...run]]
    }
    case 'interrupt':
      if (event.reason === 'idle-reap' && (state.admission.kind !== 'free' || q.head() !== null)) return unchanged(state)
      return [seal({ kind: 'stopping', gen: state.gen, have: state.have, destination: destination(event.reason, q, ctx) }),
        [{ e: 'teardown', gen: state.gen, have: state.have }]]
    case 'stage-ok': case 'stage-fail': case 'settled': case 'restore': case 'signed-in':
      return protocol(state, event)
    default: return assertNever(event)
  }
}

function settle(state: Extract<Life, { kind: 'stopping' }>, q: PendingView, ctx: StepContext): Transition {
  const effects: Effect[] = q.dispatching().map(seq => ({ e: 'write-receipt', seq, receipt: { state: 'unknown' } }))
  const dest = state.destination
  switch (dest.kind) {
    case 'deleted': return [seal({ kind: 'archived' }), [...effects, { e: 'remove' }]]
    case 'archived': return [seal({ kind: 'archived' }), [...effects, ...archivedRows(q), { e: 'write-hold', hold: null }]]
    case 'rest': {
      if (dest.wakeAfter) {
        const [next, run] = start(ctx, true)
        return [next, [...effects, ...run]]
      }
      return [seal({ kind: 'dormant', hold: null, lastExit: null }), [...effects, { e: 'write-hold', hold: null }]]
    }
    case 'held': {
      const hold = dest.hold
      if (hold.reason !== 'sign-out' && afterBarrier(q, hold.barrier)) {
        const [next, run] = start(ctx, true)
        return [next, [...effects, ...run]]
      }
      const next = hold.reason === 'start-failed' ? seal({ kind: 'failed', hold }) : seal({ kind: 'dormant', hold, lastExit: null })
      return [next, [...effects, { e: 'write-hold', hold }]]
    }
    default: return assertNever(dest)
  }
}

function stepStopping(state: Extract<Life, { kind: 'stopping' }>, event: Event, q: PendingView, ctx: StepContext): Transition {
  switch (event.k) {
    case 'interrupt': return [seal({ ...state, destination: tighten(state.destination, event.reason, q, ctx) }), []]
    case 'deliver':
      switch (state.destination.kind) {
        case 'archived': case 'deleted': return [state, [{ e: 'write-receipt', seq: event.seq,
          receipt: { state: 'failed', cause: { name: 'SessionArchived', message: 'Session is archived' } } }]]
        case 'rest': return [seal({ ...state, destination: { kind: 'rest', wakeAfter: true } }), []]
        case 'held': return unchanged(state)
        default: return assertNever(state.destination)
      }
    case 'start':
      return state.destination.kind === 'rest' || (state.destination.kind === 'held' && state.destination.hold.reason !== 'sign-out')
        ? [seal({ ...state, destination: { kind: 'rest', wakeAfter: true } }), []] : unchanged(state)
    case 'stage-ok': return [state, [{ e: 'teardown', gen: state.gen, have: { [event.out.at]: event.out.value } }]]
    case 'stage-fail': case 'exit': case 'turn-busy': case 'turn-idle': return unchanged(state)
    case 'receipt': return [state, receiptEffects(event)]
    case 'settled': return settle(state, q, ctx)
    case 'restore': case 'signed-in': return protocol(state, event)
    default: return assertNever(event)
  }
}

function stepArchived(state: Extract<Life, { kind: 'archived' }>, event: Event): Transition {
  switch (event.k) {
    case 'deliver': return [state, [{ e: 'write-receipt', seq: event.seq,
      receipt: { state: 'failed', cause: { name: 'SessionArchived', message: 'Session is archived' } } }]]
    case 'restore': return [seal({ kind: 'dormant', hold: null, lastExit: null }), []]
    case 'start': case 'signed-in': return unchanged(state)
    case 'interrupt': return event.reason === 'delete' ? [state, [{ e: 'remove' }]] : unchanged(state)
    case 'stage-ok': case 'stage-fail': case 'receipt': case 'turn-busy': case 'turn-idle': case 'exit': case 'settled':
      return protocol(state, event)
    default: return assertNever(event)
  }
}

/** Decide and emit effects only. The owner commits receipt/hold effects before doing external IO. */
export function step(state: Life, event: Event, q: PendingView, ctx: StepContext): Transition {
  if ('gen' in event) {
    if (state.kind === 'dormant' || state.kind === 'failed' || state.kind === 'archived' || !sameGen(state.gen, event.gen)) return unchanged(state)
  }
  switch (state.kind) {
    case 'dormant': return stepDormant(state, event, q, ctx)
    case 'failed': return stepFailed(state, event, q, ctx)
    case 'starting': return stepStarting(state, event, q, ctx)
    case 'ready': return stepReady(state, event, q, ctx)
    case 'stopping': return stepStopping(state, event, q, ctx)
    case 'archived': return stepArchived(state, event)
    default: return assertNever(state)
  }
}
