import { StringDecoder } from 'node:string_decoder'

const MAX_FRAME_CHARS = 64 * 1024
const heartbeat = (name: string) => /^(ping|keepalive|keep-alive|heartbeat)$/i.test(name)

/** Timing metadata only. No headers, URLs, event names, or model content leave this observer. */
export interface PlatformStreamTiming {
  startedAt: string
  durationMs: number
  firstByteAfterMs: number | null
  firstProgressAfterMs: number | null
  lastByteAt: string | null
  lastProgressAt: string | null
  maxByteGapMs: number | null
  maxProgressGapMs: number | null
  frames: number
  heartbeatFrames: number
  progressFrames: number
  unclassifiedFrames: number
  eventTimingAvailable: boolean
  complete: boolean
}

/** Passive SSE observation: never buffers, delays, changes, or terminates the forwarded stream. */
export class PlatformStreamTimingRecorder {
  private readonly start: number
  private readonly decoder = new StringDecoder('utf8')
  private line = ''
  private oversizedLine = false
  private eventName = ''
  private dataLines: string[] = []
  private frameChars = 0
  private oversizedFrame = false
  private comment = false
  private firstByte: number | null = null
  private lastByte: number | null = null
  private firstProgress: number | null = null
  private lastProgress: number | null = null
  private maxByteGap = 0
  private maxProgressGap = 0
  private frames = 0
  private heartbeatFrames = 0
  private progressFrames = 0
  private unclassifiedFrames = 0

  constructor(
    private readonly parseEvents = true,
    private readonly now: () => number = () => performance.now(),
    private readonly wallStart = Date.now(),
    start = now(),
  ) {
    this.start = start
  }

  data(bytes: Buffer): void {
    if (!bytes.length) return
    const at = this.now()
    if (this.firstByte === null) this.firstByte = at
    if (this.lastByte !== null) this.maxByteGap = Math.max(this.maxByteGap, at - this.lastByte)
    this.lastByte = at
    if (!this.parseEvents) return
    const text = this.decoder.write(bytes)
    for (let offset = 0; offset < text.length;) {
      const newline = text.indexOf('\n', offset)
      const end = newline < 0 ? text.length : newline
      if (!this.oversizedLine) {
        if (this.line.length + end - offset > MAX_FRAME_CHARS) {
          this.line = ''
          this.oversizedLine = this.oversizedFrame = true
        } else this.line += text.slice(offset, end)
      }
      if (newline < 0) break
      if (!this.oversizedLine) this.takeLine(this.line.replace(/\r$/, ''), at)
      this.line = ''
      this.oversizedLine = false
      offset = newline + 1
    }
  }

  finish(complete: boolean): PlatformStreamTiming {
    const end = this.now()
    const elapsed = (at: number | null) => at === null ? null : Math.round(at - this.start)
    const instant = (at: number | null) => at === null ? null : new Date(this.wallStart + at - this.start).toISOString()
    return {
      startedAt: new Date(this.wallStart).toISOString(), durationMs: Math.round(end - this.start),
      firstByteAfterMs: elapsed(this.firstByte), firstProgressAfterMs: elapsed(this.firstProgress),
      lastByteAt: instant(this.lastByte), lastProgressAt: instant(this.lastProgress),
      maxByteGapMs: this.lastByte === null ? null : Math.round(Math.max(this.maxByteGap, end - this.lastByte)),
      maxProgressGapMs: !this.parseEvents ? null : Math.round(Math.max(this.maxProgressGap, end - (this.lastProgress ?? this.start))),
      frames: this.frames, heartbeatFrames: this.heartbeatFrames, progressFrames: this.progressFrames,
      unclassifiedFrames: this.unclassifiedFrames, eventTimingAvailable: this.parseEvents, complete,
    }
  }

  private takeLine(line: string, at: number): void {
    if (line) {
      if (line.startsWith(':')) this.comment = true
      else if (line.startsWith('event:')) this.eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        this.frameChars += line.length
        if (this.frameChars > MAX_FRAME_CHARS) this.oversizedFrame = true
        else this.dataLines.push(line.slice(5).trimStart())
      }
      return
    }
    if (this.comment || this.eventName || this.dataLines.length || this.oversizedFrame) {
      this.frames += 1
      const data = this.dataLines.join('\n')
      let name = this.eventName
      if (!name && data && !this.oversizedFrame) {
        try { name = (JSON.parse(data) as { type?: string }).type ?? '' } catch { /* OpenAI [DONE] and comments are not JSON. */ }
      }
      if (this.oversizedFrame) this.unclassifiedFrames += 1
      else if (heartbeat(name) || (this.comment && !data && !name)) this.heartbeatFrames += 1
      else if (data || name) {
        this.progressFrames += 1
        if (this.firstProgress === null) this.firstProgress = at
        if (this.lastProgress !== null) this.maxProgressGap = Math.max(this.maxProgressGap, at - this.lastProgress)
        this.lastProgress = at
      }
    }
    this.eventName = ''
    this.dataLines = []
    this.frameChars = 0
    this.oversizedFrame = this.comment = false
  }
}
