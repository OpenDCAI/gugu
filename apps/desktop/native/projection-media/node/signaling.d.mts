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
export class ProjectionSignals {
  constructor(deps: {
    authorize(context: ProjectionSignalContext, sourceId: string): Promise<ProjectionSignalLease>
    openMedia(lease: ProjectionSignalLease, signal: AbortSignal, onControl: (data: string) => void): Promise<MediaProcess>
  })
  receive(context: ProjectionSignalContext, command: ProjectionSignalCommand): Promise<unknown>
  closeBinding(context: ProjectionSignalContext): Promise<void>
  dispose(): Promise<void>
}
