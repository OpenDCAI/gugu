import { describe, expect, it, vi } from 'vitest'
import { parseVoiceNoteMeta, VOICE_NOTE_MIN_SEGMENT_VOICED_MS, VOICE_NOTE_MIN_TOTAL_VOICED_MS, voiceNoteView } from '@gugu/core/shared/voiceNotes'
import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine, MachineRpc } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
import type { BacklogJob, VoiceBacklog } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceBacklog'
import {
  createPhoneVoiceJobs,
  type VoiceJobHeld,
  type VoiceJobView,
  type VoiceNotesContext,
} from '../../../apps/desktop/src/mobile/assistant/phoneVoiceJobs'
import type { RecordedSegment, RecorderHandlers } from '../../../apps/desktop/src/mobile/assistant/phoneVoiceRecorder'

// #7199 手机上一条语音笔记从录下到「传上去」:录 → 分段传到它家里同一个语音笔记目录 → note.json 标 uploaded(等转写)。
// 手机 ❌ 转写、❌ 签票、❌ 交总结。全用假的它家里(内存里的文件)、假的录音机与存储,测的是步骤本身:
// 没醒不替人叫醒、录音留在手机上、醒了自己接着传、放弃不留痕迹、进程被杀后接着传。

const HOME = '/home/u'
const WORKDIR = '/home/u/assistant'
const paths = assistantPaths(HOME, WORKDIR)
const NOTES = `${paths.memoryDir}/voice-notes`

function fakeHome() {
  const text = new Map<string, string>()
  const binary = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const pending = new Map<string, Uint8Array[]>()
  const log: string[] = []
  const rpc = {
    workspace: {
      files: {
        readExternalFile: async (_p: string, _w: string, path: string) => {
          const content = text.get(path)
          if (content === undefined) return { success: false, error: { type: 'fs_error', message: `ENOENT: no such file or directory, open '${path}'` } }
          return { success: true, data: { content, truncated: false, totalSize: content.length } }
        },
        writeExternalFile: async (_p: string, _w: string, path: string, content: string) => {
          log.push(`write ${path.slice(path.lastIndexOf('/') + 1)}`)
          text.set(path, content)
          return { success: true, data: {} }
        },
        createEntry: async (_p: string, _w: string, dir: string, name: string) => {
          const path = `${dir}/${name}`
          if (dirs.has(path)) return { success: false, error: { type: 'exists' } }
          dirs.add(path)
          return { success: true, data: { path } }
        },
        writeChunk: async (_p: string, _w: string, chunk: { path: string; data: string; final: boolean }) => {
          const parts = pending.get(chunk.path) ?? []
          parts.push(new Uint8Array(Buffer.from(chunk.data, 'base64')))
          pending.set(chunk.path, parts)
          if (chunk.final) {
            log.push(`upload ${chunk.path.slice(chunk.path.lastIndexOf('/') + 1)}`)
            binary.set(chunk.path, new Uint8Array(Buffer.concat(parts)))
            pending.delete(chunk.path)
          }
          return { success: true, data: {} }
        },
        removeFile: async (_p: string, _w: string, path: string) => {
          log.push(`remove ${path.slice(path.lastIndexOf('/') + 1)}`)
          for (const key of [...text.keys()]) if (key.startsWith(path)) text.delete(key)
          for (const key of [...binary.keys()]) if (key.startsWith(path)) binary.delete(key)
          return { success: true, data: { success: true } }
        },
      },
    },
  }
  const machine: AssistantMachine = { deviceId: 'cloud', rpc: rpc as unknown as MachineRpc, home: HOME, projectId: 'p1', workspaceId: 'w1', paths }
  return { machine, text, binary, log }
}

function fakeBacklog() {
  const jobs = new Map<string, BacklogJob>()
  const segments = new Map<string, Blob>()
  const ops: string[] = []
  const backlog: VoiceBacklog = {
    list: async () => [...jobs.values()].map((job) => structuredClone(job)),
    saveJob: async (job) => {
      ops.push(`saveJob uploaded=${job.segments.filter((s) => s.uploaded).length}`)
      jobs.set(job.id, structuredClone(job))
    },
    saveSegment: async (jobId, file, blob) => {
      ops.push(`saveSegment ${file}`)
      segments.set(`${jobId}/${file}`, blob)
    },
    readSegment: async (jobId, file) => segments.get(`${jobId}/${file}`) ?? null,
    dropSegment: async (jobId, file) => {
      ops.push(`dropSegment ${file}`)
      segments.delete(`${jobId}/${file}`)
    },
    dropJob: async (jobId) => {
      ops.push('dropJob')
      jobs.delete(jobId)
      for (const key of [...segments.keys()]) if (key.startsWith(`${jobId}/`)) segments.delete(key)
    },
  }
  return { backlog, jobs, segments, ops }
}

function fakeRecorder() {
  const state = { handlers: null as RecorderHandlers | null, busy: false, stops: 0, error: null as string | null }
  return {
    state,
    recorder: {
      get busy() {
        return state.busy
      },
      start: async (handlers: RecorderHandlers) => {
        state.handlers = handlers
        state.busy = true
        return true
      },
      stop: () => void (state.stops += 1),
      getSnapshot: () => ({ phase: 'recording' as const, elapsedMs: 0, level: 0, silentMs: 0, error: state.error as never }),
    },
    segment(index: number, input: Partial<RecordedSegment> = {}): RecordedSegment {
      return { index, blob: new Blob([new Uint8Array(1000 + index)], { type: 'audio/wav' }), extension: 'wav', startMs: index * 300_000, durationMs: 300_000, voicedMs: 5_000, ...input }
    },
  }
}

function setup(options: { ready?: boolean; held?: VoiceJobHeld } = {}) {
  const home = fakeHome()
  const store = fakeBacklog()
  const rec = fakeRecorder()
  const env = { ready: options.ready ?? true, held: options.held ?? ('asleep' as VoiceJobHeld), assistantId: 'assistant-1' }
  const context: VoiceNotesContext = {
    deviceId: 'cloud',
    get assistantId() {
      return env.assistantId
    },
    machine: () => (env.ready ? home.machine : null),
    held: () => env.held,
  }
  const clock = { at: Date.parse('2026-10-16T09:00:00Z') }
  const jobs = createPhoneVoiceJobs({
    context: () => context,
    recorder: rec.recorder,
    backlog: store.backlog,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    now: () => new Date(clock.at),
    random: () => 'ab12',
    warn: () => undefined,
  })
  const view = (): VoiceJobView => jobs.getSnapshot()[0]!
  const meta = (id: string) => parseVoiceNoteMeta(home.text.get(`${NOTES}/${id}/note.json`) ?? '')
  return { home, store, rec, env, jobs, clock, view, meta }
}

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2_000, interval: 5 })

describe('录 → 传 → 停在「已传上去、待转写」', () => {
  it('一路走完:段边录边传(.wav 原字节),录完都传上去 → note.json 标 uploaded、段 transcribed:false,手机上的备份清掉,之后没有任何后续', async () => {
    const t = setup()
    await expect(t.jobs.start()).resolves.toBe('started')
    const id = t.view().id
    expect(t.view()).toMatchObject({ phase: 'recording', held: null })
    // 开录就在它家里建好夹子与 README(列表里能看到「正在录音」);note.json 记 source = phone。
    await until(() => expect(t.meta(id)).toMatchObject({ status: 'recording', source: 'phone' }))
    expect(t.home.text.get(`${NOTES}/README.md`)).toContain('语音笔记')

    t.rec.state.handlers!.onSegment(t.rec.segment(0))
    await until(() => expect(t.home.binary.has(`${NOTES}/${id}/audio/000.wav`)).toBe(true))
    // 传上去的就是录下的那份 WAV 原字节。
    expect(t.home.binary.get(`${NOTES}/${id}/audio/000.wav`)!.length).toBe(1000)
    t.rec.state.handlers!.onSegment(t.rec.segment(1))
    t.rec.state.handlers!.onEnd({ durationMs: 600_000, interrupted: false })

    await until(() => expect(t.view().phase).toBe('uploaded'))
    expect([...t.home.binary.keys()].sort()).toEqual([`${NOTES}/${id}/audio/000.wav`, `${NOTES}/${id}/audio/001.wav`])
    const meta = t.meta(id)!
    expect(meta).toMatchObject({ status: 'uploaded', durationMs: 600_000, source: 'phone', failure: null })
    expect(meta.segments.map((s) => ({ file: s.file, transcribed: s.transcribed, voicedMs: s.voicedMs }))).toEqual([
      { file: 'audio/000.wav', transcribed: false, voicedMs: 5_000 },
      { file: 'audio/001.wav', transcribed: false, voicedMs: 5_000 },
    ])
    // 列表 / 详情看到的是「等转写」,❌ 处理中、❌ 15 分钟后判失败。
    expect(voiceNoteView(meta, undefined, Date.parse(meta.updatedAt))).toEqual({ kind: 'queued' })
    expect(voiceNoteView(meta, undefined, Date.parse(meta.updatedAt) + 24 * 3_600_000)).toEqual({ kind: 'queued' })
    // 手机上的备份清掉;它家里没有转写、没有总结(那是桌面接着做的事)。
    await until(() => expect(t.store.jobs.size).toBe(0))
    expect(t.store.segments.size).toBe(0)
    expect(t.home.text.has(`${NOTES}/${id}/transcript.md`)).toBe(false)
    expect(t.home.text.has(`${NOTES}/${id}/summary.md`)).toBe(false)
  })

  it('总有声时长不到阈值(与桌面同一个):标 no_speech,不必等人转写', async () => {
    const t = setup()
    await t.jobs.start()
    const id = t.view().id
    t.rec.state.handlers!.onSegment(t.rec.segment(0, { voicedMs: VOICE_NOTE_MIN_TOTAL_VOICED_MS - 1 }))
    t.rec.state.handlers!.onEnd({ durationMs: 60_000, interrupted: false })
    await until(() => expect(t.view().phase).toBe('no_speech'))
    expect(t.meta(id)).toMatchObject({ status: 'no_speech' })
  })

  it('刚好到阈值就是要转写的(边界与桌面一致)', async () => {
    const t = setup()
    await t.jobs.start()
    const id = t.view().id
    t.rec.state.handlers!.onSegment(t.rec.segment(0, { voicedMs: VOICE_NOTE_MIN_TOTAL_VOICED_MS }))
    t.rec.state.handlers!.onEnd({ durationMs: 60_000, interrupted: false })
    await until(() => expect(t.view().phase).toBe('uploaded'))
    expect(VOICE_NOTE_MIN_SEGMENT_VOICED_MS).toBeLessThan(VOICE_NOTE_MIN_TOTAL_VOICED_MS)
    expect(t.meta(id)).toMatchObject({ status: 'uploaded' })
  })
})

describe('它在休息 / 连不上:❌ 替人叫醒,录音留在手机上,醒了自己接着传', () => {
  it('睡着时录:什么都不写它家里,段存在手机上,界面按 held 说;醒了接着传到 uploaded', async () => {
    const t = setup({ ready: false, held: 'asleep' })
    await t.jobs.start()
    const id = t.view().id
    await until(() => expect(t.view().held).toBe('asleep'))
    t.rec.state.handlers!.onSegment(t.rec.segment(0))
    t.rec.state.handlers!.onEnd({ durationMs: 300_000, interrupted: false })
    await until(() => expect(t.store.segments.has(`${id}/audio/000.wav`)).toBe(true))
    expect(t.home.log).toEqual([])
    // 手机上留了记录(进程被杀也在)。
    await until(() => expect(t.store.jobs.get(id)?.recordingDone).toBe(true))

    t.env.ready = true
    await until(() => expect(t.view().phase).toBe('uploaded'))
    expect(t.view().held).toBeNull()
    expect(t.home.binary.has(`${NOTES}/${id}/audio/000.wav`)).toBe(true)
    // 传上去之后手机上那份字节放掉;并且是先记「已传」再放字节(反过来,中间被杀就丢了一段)。
    const order = t.store.ops.filter((op) => op.startsWith('saveJob uploaded=1') || op.startsWith('dropSegment'))
    expect(order.indexOf('saveJob uploaded=1')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('saveJob uploaded=1')).toBeLessThan(order.indexOf('dropSegment audio/000.wav'))
  })

  it('held 的原因随它的状态变:正在醒 / 连不上', async () => {
    const t = setup({ ready: false, held: 'waking' })
    await t.jobs.start()
    await until(() => expect(t.view().held).toBe('waking'))
    t.env.held = 'unreachable'
    await until(() => expect(t.view().held).toBe('unreachable'))
  })

  it('当前的上下文不是这条笔记的助理(换了号):不拿别人的它家里写,当作连不上,换回来再接着传', async () => {
    const t = setup()
    await t.jobs.start()
    const id = t.view().id
    await until(() => expect(t.home.text.has(`${NOTES}/${id}/note.json`)).toBe(true))
    t.env.assistantId = 'someone-else'
    t.rec.state.handlers!.onSegment(t.rec.segment(0))
    await until(() => expect(t.view().held).toBe('unreachable'))
    expect(t.home.binary.size).toBe(0)
    t.env.assistantId = 'assistant-1'
    await until(() => expect(t.home.binary.has(`${NOTES}/${id}/audio/000.wav`)).toBe(true))
  })
})

describe('失败与重试', () => {
  it('上传失败:如实说是「上传」那一步(可重试);重试从传接着做,传好了停在 uploaded', async () => {
    const t = setup()
    await t.jobs.start()
    const id = t.view().id
    await until(() => expect(t.home.text.has(`${NOTES}/${id}/note.json`)).toBe(true))
    const rpc = t.home.machine.rpc!.workspace.files as unknown as { writeChunk: (...args: unknown[]) => Promise<unknown> }
    const original = rpc.writeChunk
    let fail = true
    rpc.writeChunk = async (...args: unknown[]) => (fail ? { success: false, error: { type: 'network', message: 'offline' } } : original(...args))
    t.rec.state.handlers!.onSegment(t.rec.segment(0))
    t.rec.state.handlers!.onEnd({ durationMs: 300_000, interrupted: false })
    await until(() => expect(t.view().phase).toBe('failed'))
    expect(t.view().failure).toMatchObject({ stage: 'upload', retryable: true })
    await until(() => expect(t.meta(id)).toMatchObject({ status: 'failed' }))
    // 失败时录音还在手机上。
    expect(t.store.segments.has(`${id}/audio/000.wav`)).toBe(true)

    fail = false
    t.jobs.retry(id)
    await until(() => expect(t.view().phase).toBe('uploaded'))
    expect(t.meta(id)).toMatchObject({ status: 'uploaded', failure: null })
  })
})

describe('放弃与进程被杀后接着传', () => {
  it('放弃:停录音、手机上的记录与它家里已建的夹子都清掉,之后不再往它家里写', async () => {
    const t = setup()
    await t.jobs.start()
    const id = t.view().id
    await until(() => expect(t.home.text.has(`${NOTES}/${id}/note.json`)).toBe(true))
    t.jobs.discard(id)
    expect(t.rec.state.stops).toBe(1)
    expect(t.jobs.getSnapshot()).toEqual([])
    await until(() => expect(t.home.log).toContain('remove ' + id))
    await until(() => expect(t.store.ops).toContain('dropJob'))
    // 录音机收尾时吐出来的最后一段与结束:已经放弃了,❌ 再被接住写回去。
    const logged = t.home.log.length
    t.rec.state.handlers!.onSegment(t.rec.segment(0))
    t.rec.state.handlers!.onEnd({ durationMs: 1_000, interrupted: false })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(t.home.log.length).toBe(logged)
    expect(t.jobs.getSnapshot()).toEqual([])
  })

  it('进程被杀后:手机上留着没传的段,restore 按记录接着传,传完停在 uploaded(没录完的当作录到那儿为止)', async () => {
    const first = setup({ ready: false })
    await first.jobs.start()
    const id = first.view().id
    first.rec.state.handlers!.onSegment(first.rec.segment(0))
    // 还没录完就被杀了:没有 onEnd。
    await until(() => expect(first.store.segments.has(`${id}/audio/000.wav`)).toBe(true))
    await until(() => expect(first.store.jobs.get(id)?.segments).toHaveLength(1))

    // 新进程:同一份手机存储,新的它家里(醒着)。
    const second = setup({ ready: true })
    for (const [key, job] of first.store.jobs) second.store.jobs.set(key, structuredClone(job))
    for (const [key, blob] of first.store.segments) second.store.segments.set(key, blob)
    await second.jobs.restore('assistant-1')
    expect(second.jobs.getSnapshot()).toHaveLength(1)
    await until(() => expect(second.jobs.getSnapshot()[0]!.phase).toBe('uploaded'))
    expect(second.home.binary.has(`${NOTES}/${id}/audio/000.wav`)).toBe(true)
    expect(second.meta(id)).toMatchObject({ status: 'uploaded', durationMs: 300_000 })
  })

  it('restore 只接这位助理的;已经在跑的不重复接', async () => {
    const t = setup()
    const record: BacklogJob = {
      id: '20261016-090000-aaaa',
      deviceId: 'cloud',
      assistantId: 'someone-else',
      meta: { version: 1, id: '20261016-090000-aaaa', createdAt: '2026-10-16T09:00:00.000Z', endedAt: null, durationMs: 0, source: 'phone', status: 'recording', failure: null, title: null, segments: [], summaryRequestedAt: null, updatedAt: '2026-10-16T09:00:00.000Z' },
      segments: [],
      recordingDone: false,
      created: false,
    }
    t.store.jobs.set(record.id, record)
    await t.jobs.restore('assistant-1')
    expect(t.jobs.getSnapshot()).toEqual([])
  })
})
