// #7199 手机录语音笔记的 PCM 这一层(纯函数,可单测):麦克风推来的任意采样率的帧 → 16k 单声道 16 位,
// 每 5 分钟(VOICE_NOTE_SEGMENT_MS)切成一段 WAV —— 与桌面送去转写的格式同一个(packages/core/src/shared/voiceNotes.ts)。
// 为什么不走 MediaRecorder:安卓 WebView 里它只吐 webm / opus,转写前还得靠 decodeAudioData 解回来,那一步在 WebView 里没有保证;
// 直接收 PCM 写 WAV,上传的就是模型要的那份,重试时也不用再解码。

/** 送去转写的采样率(单声道、16 位)。 */
export const VOICE_NOTE_SAMPLE_RATE = 16_000

/** 比这响就算有人在说话(经过系统的降噪 / 自动增益之后的读数;与桌面录音机同值)。 */
export const VOICE_RMS = 0.015
/** 比这还轻 = 几乎没声音(麦克风静音、拔了)。 */
export const SILENT_RMS = 0.002

/** 一帧的均方根(0–1)。 */
export function rmsOf(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!
  return Math.sqrt(sum / frame.length)
}

/** 波形条高度 0–1:−60 dB 到 −10 dB 线性铺开(与桌面录音机同一条曲线)。 */
export function levelOf(rms: number): number {
  return rms <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 50))
}

/**
 * 流式降采样:每个输出样本取它那一格窗口里输入样本的面积平均(窗口 = 输入率 / 输出率 个样本,可以是小数),
 * 自带一道粗的抗混叠;同采样率时原样通过。帧与帧之间的窗口接得上,❌ 每帧各算各的。
 */
export class Downsampler {
  private readonly ratio: number
  private position = 0
  private produced = 0
  private acc = 0
  private weight = 0

  constructor(inputRate: number, outputRate = VOICE_NOTE_SAMPLE_RATE) {
    this.ratio = inputRate / outputRate
  }

  /** 推进一帧,返回这一帧里凑满的输出样本(-1..1)。 */
  push(frame: Float32Array): Float32Array {
    const out: number[] = []
    for (let i = 0; i < frame.length; i += 1) {
      const x = frame[i]!
      let start = this.position
      const end = this.position + 1
      while (start < end) {
        const windowEnd = (this.produced + 1) * this.ratio
        const upTo = Math.min(end, windowEnd)
        const w = upTo - start
        this.acc += x * w
        this.weight += w
        start = upTo
        if (upTo >= windowEnd - 1e-9) {
          out.push(this.weight > 0 ? this.acc / this.weight : 0)
          this.acc = 0
          this.weight = 0
          this.produced += 1
        }
      }
      this.position = end
    }
    return Float32Array.from(out)
  }
}

export function floatToInt16(samples: Float32Array, into: Int16Array, at: number): void {
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    into[at + i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
}

/** 44 字节的 WAV 头:单声道、16 位 PCM。 */
export function wavHeader(sampleCount: number, sampleRate = VOICE_NOTE_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  return bytes
}

export type PcmSegment = {
  index: number
  /** 这一段从整条录音的第几毫秒开始(暂停不算时间)。 */
  startMs: number
  durationMs: number
  /** 这一段里有人声的毫秒数。 */
  voicedMs: number
  wav: Blob
}

export type PcmMeter = { elapsedMs: number; level: number; silentMs: number }

/**
 * 把一路输入帧切成每 segmentMs 一段的 WAV。时间一律按样本数算(暂停时不喂帧就不走表;`elapsedMs` = 已收样本 / 采样率),
 * ❌ 读墙钟 —— 后台被系统挂起的那一阵不该算成录了多久。
 */
export class PcmSegmenter {
  private readonly down: Downsampler
  private readonly segmentSamples: number
  private buffer: Int16Array
  private filled = 0
  private index = 0
  private totalSamples = 0
  private segmentStartSamples = 0
  private voicedMs = 0
  private silentMs = 0
  private lastLevel = 0

  constructor(
    private readonly inputRate: number,
    private readonly onSegment: (segment: PcmSegment) => void,
    segmentMs: number,
  ) {
    this.down = new Downsampler(inputRate)
    this.segmentSamples = Math.max(1, Math.round((segmentMs / 1000) * VOICE_NOTE_SAMPLE_RATE))
    // 多留一帧的余量:一帧进来可能跨过整段边界,整段在这一帧之后才切(最多晚几十毫秒,不丢样本)。
    this.buffer = new Int16Array(this.segmentSamples + 8192)
  }

  get meter(): PcmMeter {
    return { elapsedMs: (this.totalSamples / VOICE_NOTE_SAMPLE_RATE) * 1000, level: this.lastLevel, silentMs: this.silentMs }
  }

  /** 推进一帧;返回此刻的读数(录音条要画)。 */
  push(frame: Float32Array): PcmMeter {
    const frameMs = (frame.length / this.inputRate) * 1000
    const rms = rmsOf(frame)
    if (rms > VOICE_RMS) this.voicedMs += frameMs
    this.silentMs = rms < SILENT_RMS ? this.silentMs + frameMs : 0
    this.lastLevel = levelOf(rms)
    const samples = this.down.push(frame)
    this.write(samples)
    return this.meter
  }

  private write(samples: Float32Array): void {
    let offset = 0
    while (offset < samples.length) {
      const room = this.buffer.length - this.filled
      const take = Math.min(room, samples.length - offset)
      floatToInt16(samples.subarray(offset, offset + take), this.buffer, this.filled)
      this.filled += take
      this.totalSamples += take
      offset += take
      if (this.filled >= this.segmentSamples) this.cut()
    }
  }

  /** 切下当前这一段(没有样本就什么也不出)。录完时调一次把最后一段交出去。 */
  cut(): void {
    if (this.filled === 0) return
    const samples = this.buffer.subarray(0, this.filled)
    const startMs = (this.segmentStartSamples / VOICE_NOTE_SAMPLE_RATE) * 1000
    const durationMs = (this.filled / VOICE_NOTE_SAMPLE_RATE) * 1000
    // Blob 构造时把字节拷走了,buffer 可以接着用。
    const wav = new Blob([wavHeader(this.filled) as BlobPart, samples as BlobPart], { type: 'audio/wav' })
    this.onSegment({ index: this.index, startMs, durationMs, voicedMs: Math.min(this.voicedMs, durationMs), wav })
    this.index += 1
    this.segmentStartSamples = this.totalSamples
    this.filled = 0
    this.voicedMs = 0
  }
}
