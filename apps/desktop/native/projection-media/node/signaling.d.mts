import type { MediaProcess } from './host.mjs'
/** Must be stamped by the authenticated host page, never supplied by the App. */
export type ProjectionSignalContext = Readonly<{
  ownerId: string; deviceId: string; appId: string; sessionId: string; pageId: string; epoch: string
}>
/** The actual source registry/grant creates this; a payload's session id is not a lease. */
export type ProjectionSignalLease = {
  context: ProjectionSignalContext; sourceId: string; signal: AbortSignal
  assertCurrent(): Promise<void>
  receive(data: string, signal: AbortSignal): Promise<string | undefined>
  disconnect(): Promise<void>
  release(): void
}
export type ProjectionSignalCommand =
  | { type: 'open'; sourceId: string; requestId: string }
  | { type: 'answer'; id: string; sdp: { type: 'answer'; sdp: string } }
  | { type: 'close'; id: string }
export type ProjectionDiagnostic = Readonly<{
  id: string; sourceId: string; context: ProjectionSignalContext; phase: string; error: Error
}>
export class ProjectionSignals {
  constructor(deps: {
    /** Background failures converge here; omitted sinks write bounded diagnostics to stderr. */
    onError?(event: ProjectionDiagnostic): void
    /** Honor cancellation while resolving host authority; a closed page must not keep waiting. */
    authorize(context: ProjectionSignalContext, sourceId: string, signal: AbortSignal): Promise<ProjectionSignalLease>
    openMedia(lease: ProjectionSignalLease, signal: AbortSignal, onControl: (data: string) => void): Promise<MediaProcess>
  })
  receive(context: ProjectionSignalContext, command: ProjectionSignalCommand): Promise<unknown>
  closeBinding(context: ProjectionSignalContext): Promise<void>
  dispose(): Promise<void>
}
