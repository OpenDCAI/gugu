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
export type AdmittedChannel = Brand<Readonly<{ gen: Gen }>, 'AdmittedChannel'>

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
  [K in StageName]: Readonly<{ at: K; have: Have<K>; since: number }>
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
export type StartFailedHold = Readonly<{ reason: 'start-failed'; barrier: Seq | null; stage: StageName; cause: SerializedError }>
export type Hold = UserStopHold | SignOutHold | StartFailedHold
export type Destination =
  | Readonly<{ kind: 'rest'; wakeAfter: boolean }>
  | Readonly<{ kind: 'held'; hold: Hold }>
  | Readonly<{ kind: 'archived' }>
  | Readonly<{ kind: 'deleted' }>

export interface ExitFact {
  readonly cause: SerializedError
  readonly code: number | null
  readonly signal: string | null
}

export type LifeShape =
  | Readonly<{ kind: 'dormant'; hold: UserStopHold | SignOutHold | null; lastExit: ExitFact | null }>
  | Readonly<{ kind: 'starting'; gen: Gen; progress: Progress }>
  | Readonly<{ kind: 'ready'; gen: Gen; have: StageOut; timing: Timing; admission: Admission }>
  | Readonly<{ kind: 'stopping'; gen: Gen | null; destination: Destination; have: Partial<StageOut> }>
  | Readonly<{ kind: 'failed'; hold: StartFailedHold }>
  | Readonly<{ kind: 'archived' }>
export type Life = Brand<LifeShape, 'Life'>

export type Receipt =
  | Readonly<{ state: 'queued' }>
  | Readonly<{ state: 'dispatching'; attempt: Attempt }>
  | Readonly<{ state: 'accepted'; nativeReceiptId: string | null }>
  | Readonly<{ state: 'failed'; cause: SerializedError }>
  | Readonly<{ state: 'unknown' }>

export type Interrupt = 'user-stop' | 'archive' | 'delete' | 'sign-out' | 'version-switch' | 'idle-reap'
export type ReceiptEvent = Readonly<{ k: 'receipt'; gen: Gen; seq: Seq }> & (
  | Readonly<{ result: 'accepted'; nativeReceiptId: string | null }>
  | Readonly<{ result: 'rejected-before-admission'; nativeReceiptId: null; cause: SerializedError }>
)
export type Event =
  | Readonly<{ k: 'deliver'; seq: Seq }>
  | Readonly<{ k: 'start'; origin: 'user-open' | 'retry' }>
  | Readonly<{ k: 'stage-ok'; gen: Gen; out: StageResult }>
  | Readonly<{ k: 'stage-fail'; gen: Gen; at: StageName; cause: SerializedError }>
  | ReceiptEvent
  | Readonly<{ k: 'turn-busy'; gen: Gen }>
  | Readonly<{ k: 'turn-idle'; gen: Gen }>
  | Readonly<{ k: 'exit'; gen: Gen; exit: ExitFact }>
  | Readonly<{ k: 'interrupt'; reason: Interrupt }>
  | Readonly<{ k: 'settled'; gen: Gen | null }>
  | Readonly<{ k: 'restore' }>
  | Readonly<{ k: 'signed-in'; userId: string }>

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

/** Immutable database facts for the current decision, excluding the row already in flight. */
export interface PendingView {
  head(): Seq | null
  maxSeq(): Seq | null
  queued(): readonly Seq[]
  dispatching(): readonly Seq[]
}

/** The owner supplies facts; step never reads a clock, account singleton or attempt counter. */
export interface StepContext {
  readonly next: Gen
  readonly ownerUserId: string
  readonly since: number
  readonly timing: Timing
}
export type Transition = readonly [Life, readonly Effect[]]
