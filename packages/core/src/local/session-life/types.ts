import type { SerializedError } from '@gugu/session-shared/result'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AuthEpoch = Brand<number, 'AuthEpoch'>
export type Attempt = Brand<number, 'Attempt'>
export type Seq = Brand<number, 'PendingSeq'>
export type Gen = Readonly<{ auth: AuthEpoch; attempt: Attempt }>
export type Timing = 'next-tool-call' | 'idle-only'
export type { SerializedError }

export const STAGES = ['identity', 'workspace', 'capabilities', 'platform', 'cli', 'process', 'channel'] as const
export type StageName = (typeof STAGES)[number]

export type BoundIdentity = Readonly<{ kind: 'bound'; agentUserId: string } | { kind: 'private' }>
type None = Readonly<{ kind: 'none' }>
// Resource contents and admission proofs are constructed by the adapters, never by the reducer.
export type WorkspaceLease = Brand<object, 'WorkspaceLease'> | None
export type CapabilityGrant = Brand<object, 'CapabilityGrant'> | None
export type PlatformTicket = Brand<object, 'PlatformTicket'> | None
export type ResolvedCli = Brand<object, 'ResolvedCli'> | None
export type ProcessLease = Brand<object, 'ProcessLease'>
// nativeSession: this attempt continued the previous provider session or got a new one (null on a first start).
export type AdmittedChannel = Brand<Readonly<{ gen: Gen; timing: Timing; nativeSession: 'preserved' | 'replaced' | null }>, 'AdmittedChannel'>

export interface StageOut {
  readonly identity: BoundIdentity
  readonly workspace: WorkspaceLease
  readonly capabilities: CapabilityGrant
  readonly platform: PlatformTicket
  readonly cli: ResolvedCli
  readonly process: ProcessLease
  readonly channel: AdmittedChannel
}

type Before<K extends StageName, T extends readonly StageName[] = typeof STAGES, Acc extends StageName = never> =
  T extends readonly [infer H extends StageName, ...infer R extends StageName[]]
    ? H extends K ? Acc : Before<K, R, Acc | H>
    : never
export type Have<K extends StageName> = Readonly<Pick<StageOut, Before<K>>>
export type Progress = {
  [K in StageName]: Readonly<{ at: K; have: Have<K> }>
}[StageName]
export type StageResult = {
  [K in StageName]: Readonly<{ at: K; value: StageOut[K] }>
}[StageName]

export type Admission =
  | Readonly<{ kind: 'free' }>
  | Readonly<{ kind: 'awaiting'; seq: Seq }>
  | Readonly<{ kind: 'busy' }>
export type UserStopHold = Readonly<{ reason: 'user-stop'; barrier: Seq | null }>
export type SignOutHold = Readonly<{ reason: 'sign-out'; ownerUserId: string; prior: UserStopHold | null }>
/**
 * awaitsPerson: the leg said only the person can resolve it (e.g. the engine no longer has the session's record): new
 * input waits in the queue instead of starting it again; their explicit retry or a new configuration starts it.
 */
export type StartFailedHold = Readonly<{ reason: 'start-failed'; barrier: Seq | null; stage: StageName; cause: SerializedError; awaitsPerson?: true }>
/** v3.1 #9: an effect threw. Like start-failed, its barrier keeps the failed batch from retrying on its own. */
export type FaultHold = Readonly<{ reason: 'effect-fault'; barrier: Seq | null; cause: SerializedError }>
export type FailureHold = StartFailedHold | FaultHold
export type Hold = UserStopHold | SignOutHold | FailureHold
export type Destination =
  | Readonly<{ kind: 'rest'; wakeAfter: boolean }>
  | Readonly<{ kind: 'held'; hold: UserStopHold | SignOutHold | StartFailedHold }>
  | Readonly<{ kind: 'archived' }>
  | Readonly<{ kind: 'deleted' }>

export interface ExitFact {
  readonly cause: SerializedError
  readonly code: number | null
  readonly signal: string | null
}

export type Residue = Readonly<{ gen: Gen | null; have: Partial<StageOut> }>

export type LifeShape =
  | Readonly<{ kind: 'dormant'; hold: UserStopHold | SignOutHold | null; lastExit: ExitFact | null }>
  /** told: rows through this seq were already told this session could not start (N4: a retry does not tell them again). */
  | Readonly<{ kind: 'starting'; gen: Gen; progress: Progress; told: Seq | null }>
  | Readonly<{ kind: 'ready'; gen: Gen; have: StageOut; admission: Admission }>
  | Readonly<{ kind: 'stopping'; gen: Gen | null; destination: Destination; have: Partial<StageOut> }>
  // residue: what faulted runs may still hold; a later start, archive or delete tears it down first. Never persisted.
  | Readonly<{ kind: 'failed'; hold: FailureHold; residue: readonly Residue[] }>
  | Readonly<{ kind: 'archived' }>
export type Life = Brand<LifeShape, 'Life'>

export type Receipt =
  /** channelLost: the row went back to the queue once because its channel was gone before admission (#552). */
  | Readonly<{ state: 'queued'; channelLost?: SerializedError }>
  | Readonly<{ state: 'dispatching'; attempt: Attempt }>
  | Readonly<{ state: 'accepted'; nativeReceiptId: string | null }>
  | Readonly<{ state: 'failed'; cause: SerializedError }>
  | Readonly<{ state: 'unknown' }>

export type Interrupt = 'user-stop' | 'archive' | 'delete' | 'sign-out' | 'version-switch' | 'idle-reap' | 'reconfigure'
export type InterruptEvent =
  | Readonly<{ k: 'interrupt'; reason: Exclude<Interrupt, 'sign-out'> }>
  | Readonly<{ k: 'interrupt'; reason: 'sign-out'; ownerUserId: string }>
export type ReceiptEvent = Readonly<{ k: 'receipt'; gen: Gen; seq: Seq }> & (
  | Readonly<{ result: 'accepted'; nativeReceiptId: string | null }>
  | Readonly<{ result: 'rejected-before-admission'; nativeReceiptId: null; cause: SerializedError }>
  /** The channel was gone before it took a byte (#552): the row is redelivered by a fresh run, once (the owner decides). */
  | Readonly<{ result: 'channel-lost'; nativeReceiptId: null; cause: SerializedError }>
)
export type Event =
  | Readonly<{ k: 'deliver'; seq: Seq }>
  | Readonly<{ k: 'start'; origin: 'user-open' | 'retry' | 'reconfigure' }>
  | Readonly<{ k: 'stage-ok'; gen: Gen; out: StageResult }>
  | Readonly<{ k: 'stage-fail'; gen: Gen; at: StageName; cause: SerializedError; awaitsPerson?: true }>
  | ReceiptEvent
  | Readonly<{ k: 'turn-busy'; gen: Gen }>
  | Readonly<{ k: 'turn-idle'; gen: Gen }>
  | Readonly<{ k: 'exit'; gen: Gen; exit: ExitFact }>
  | InterruptEvent
  | Readonly<{ k: 'settled'; gen: Gen | null }>
  | Readonly<{ k: 'restore' }>
  | Readonly<{ k: 'signed-in'; userId: string }>
  // `run` (not `gen`): a fault is accepted in every non-archived state, so the reducer judges staleness itself.
  // unreleased: the resources of a teardown that threw (possibly an earlier run's), kept for a later teardown.
  | Readonly<{ k: 'fault'; run: Gen | null; cause: SerializedError; unreleased: Residue | null }>

export type RunStageEffect = {
  [K in StageName]: Readonly<{ e: 'run-stage'; gen: Gen; at: K; have: Have<K> }>
}[StageName]
export type Effect =
  | RunStageEffect
  | Readonly<{ e: 'dispatch'; gen: Gen; seq: Seq }>
  | Readonly<{ e: 'write-receipt'; seq: Seq; receipt: Receipt }>
  | Readonly<{ e: 'abort'; gen: Gen }>
  | Readonly<{ e: 'teardown'; gen: Gen | null; have: Partial<StageOut> }>
  | Readonly<{ e: 'write-hold'; hold: Hold | null }>
  | Readonly<{ e: 'report-failure'; seqs: readonly Seq[]; cause: SerializedError }>
  | Readonly<{ e: 'mark-source-read'; seq: Seq }>
  | Readonly<{ e: 'remove' }>
  // Entering archived or deleted: the leg ends what lives only because of this session (e.g. runtime children).
  | Readonly<{ e: 'end-dependents' }>

/** Immutable database rows in ascending seq order; queued excludes rows already in flight. */
export interface PendingView {
  readonly queued: readonly Seq[]
  readonly dispatching: readonly Seq[]
}

/** The owner allocates the next generation; the reducer owns no counters or clocks. */
export interface StepContext {
  readonly next: Gen
}
export type Transition = readonly [Life, readonly Effect[]]
