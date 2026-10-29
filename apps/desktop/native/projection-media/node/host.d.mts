export type EncodedMediaFrame = Readonly<{ sequence: number; rtpTimestamp: number; width: number; height: number }>
export type MediaDescription = Readonly<{ type: 'offer' | 'answer'; sdp: string }>
export type MediaProcessOptions = {
  executable: string; ffmpeg: string; width: number; height: number; fps: number; bitrate: number
  stun?: string; signal?: AbortSignal
  /** Synchronous bounded delivery. This is not an execution acknowledgement. */
  onControl?(data: string): void
}
export type MediaProcess = Readonly<{
  offer: MediaDescription
  closed: Promise<void>
  answer(sdp: MediaDescription): Promise<void>
  publish(sequence: number, bgra: Uint8Array): Promise<EncodedMediaFrame>
  /** Resolves when handed to SCTP, never when a native action was applied. */
  sendControl(data: string): Promise<void>
  close(): Promise<void>
}>
export function openMediaProcess(options: MediaProcessOptions): Promise<MediaProcess>
export function mediaMessages(input: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>>
