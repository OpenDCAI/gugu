import { describe, expect, it } from 'vitest'
import { PlatformStreamTimingRecorder } from '../../../../apps/desktop/electron/sessionpage/platform-stream-timing'

function fixture(parse = true) {
  let at = 0
  const recorder = new PlatformStreamTimingRecorder(parse, () => at, 0)
  return { recorder, at: (value: number) => { at = value }, data: (text: string) => recorder.data(Buffer.from(text)) }
}

describe('passive model stream timings', () => {
  it('distinguishes wire heartbeats from model progress, including the trailing stalled interval', () => {
    const f = fixture()
    f.at(5_000); f.data('event: message_start\ndata: {"type":"message_start"}\n\n')
    f.at(10_000); f.data(': keepalive\n\n')
    f.at(45_000); f.data('data: {"type":"ping"}\n\n')
    f.at(60_000); f.data('event: content_block_delta\ndata: {"delta":{"text":"not logged"}}\n\n')
    f.at(65_000)
    expect(f.recorder.finish(false)).toEqual({
      startedAt: '1970-01-01T00:00:00.000Z', durationMs: 65_000,
      firstByteAfterMs: 5_000, firstProgressAfterMs: 5_000,
      lastByteAt: '1970-01-01T00:01:00.000Z', lastProgressAt: '1970-01-01T00:01:00.000Z',
      maxByteGapMs: 35_000, maxProgressGapMs: 55_000,
      frames: 4, heartbeatFrames: 2, progressFrames: 2, unclassifiedFrames: 0,
      eventTimingAvailable: true, complete: false,
    })
  })

  it('reassembles split UTF-8 and CRLF frames without recording their names or text', () => {
    const f = fixture()
    const bytes = Buffer.from('event: ping\r\ndata: {"type":"ping"}\r\n\r\nevent: content_block_delta\r\ndata: {"text":"原文"}\r\n\r\n')
    for (const byte of bytes) f.recorder.data(Buffer.from([byte]))
    const result = f.recorder.finish(true)
    expect(result).toMatchObject({ frames: 2, heartbeatFrames: 1, progressFrames: 1 })
    expect(JSON.stringify(result)).not.toMatch(/原文|content_block_delta|ping/)
  })

  it('does not mistake an oversized frame for proof of model progress', () => {
    const f = fixture()
    f.data('data: ' + 'secret'.repeat(20_000) + '\n\ndata: [DONE]\n\n')
    expect(f.recorder.finish(true)).toMatchObject({ frames: 2, unclassifiedFrames: 1, progressFrames: 1 })
  })

  it('marks encoded event timing unavailable while retaining byte timing and the original request start', () => {
    let at = 25_000
    const recorder = new PlatformStreamTimingRecorder(false, () => at, 0, 0)
    recorder.data(Buffer.from('not decompressed'))
    at = 30_000
    expect(recorder.finish(true)).toMatchObject({ firstByteAfterMs: 25_000, maxByteGapMs: 5_000,
      maxProgressGapMs: null, firstProgressAfterMs: null, frames: 0, eventTimingAvailable: false })
  })

  it('leaves a long active response intact and measures gaps independently of its total duration', () => {
    const f = fixture()
    for (let at = 0; at <= 600_000; at += 1_000) { f.at(at); f.data('data: {"text":"ongoing"}\n\n') }
    expect(f.recorder.finish(true)).toMatchObject({ durationMs: 600_000, maxByteGapMs: 1_000,
      maxProgressGapMs: 1_000, progressFrames: 601, complete: true })
  })
})
