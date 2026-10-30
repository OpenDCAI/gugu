export type DecodedProjectionFrame = Readonly<{ sequence: number; rtpTimestamp: number; width: number; height: number; recovery?: true }>
/** Transport only; the calling host still binds authorization, decoded ACKs and execution results. */
export function openProjectionVideo(options: {
  video: HTMLVideoElement
  offer: { type: 'offer'; sdp: string }
  answer(description: { type: 'answer'; sdp: string }): Promise<void>
  /** null immediately invalidates the previous visible frame; a value matches the current decoder frame. */
  onFrame?(frame: DecodedProjectionFrame | null, sendControl: (data: string) => void | Promise<void>): void
  onControl?(data: string, sendControl: (data: string) => void | Promise<void>): void
  /** Host/preload authorization; no key belongs to this browser receiver. Ordered and bounded. */
  prepareControl?(data: string, signal: AbortSignal): Promise<string> | string
  signal?: AbortSignal
}): Promise<Readonly<{
  closed: Promise<void>
  /** SCTP admission, never native execution. */
  sendControl(data: string): void | Promise<void>
  close(): void
}>>
