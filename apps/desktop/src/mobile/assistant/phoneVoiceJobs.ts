// #7199 手机上一条语音笔记从录下到「传上去」(手机只做这一半:录 → 分段传到它家里同一个语音笔记目录,再没有后续):
//   边录边把每段 WAV 传到它家里(<记忆夹>/voice-notes/<id>/audio/),录完、段都传上去了 → note.json 标 status:'uploaded'
//   (列表上「等转写」),手机上留的备份清掉。转写、交给助理写总结都在桌面咕咕里点「开始转写」接着做(voice-note-jobs 的重试,
//   读回云上的音频)。手机 ❌ 转写、❌ 签票、❌ 交总结。
// 与桌面 voice-note-jobs.ts 的差别:
//   1. 它住的云端宿主收回着 / 连不上时这里不叫(录音条 PhoneVoiceBar 看到有录音在等就让系统叫起来,owner 10-17):录音先留在手机上
//      (phoneVoiceBacklog,进程被杀也在),连上了自动接着传;这段等待不算失败,界面按 `held` 说。
//   2. 录音是 16k 单声道 WAV(.wav,就是桌面转写要的那份)。
//   3. 一个 App 进程里的进度在这一份(录音条读它);进程被杀后由 restore() 按手机上留的记录接着传。
// 所有外部依赖(录音机、它家里、存储)都从 ports 交进来,单测喂假的。
import {
  newVoiceNoteMeta,
  segmentFileName,
  serializeVoiceNoteMeta,
  voiceNoteId,
  voiceNotesReadme,
  VOICE_NOTE_AUDIO_DIR,
  VOICE_NOTE_META_FILE,
  VOICE_NOTE_MIN_TOTAL_VOICED_MS,
  VOICE_NOTES_DIR,
  VOICE_NOTES_README_FILE,
  type VoiceNoteFailure,
  type VoiceNoteMeta,
} from '@gugu/core/shared/voiceNotes'
import { joinPath } from '@/session/renderer/features/assistant/assistant-files'
import { makeFolder, readText, removePath, uploadFile, writeText, type AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import type { BacklogJob, VoiceBacklog } from './phoneVoiceBacklog'
import type { PhoneVoiceRecorder, RecordedSegment, RecorderError } from './phoneVoiceRecorder'

// ── 此刻在跟哪位助理、它家里那台打交道(助理 App 每次渲染时交进来) ─────────────────────────

/** 它家里此刻为什么读写不了:宿主收回着 / 正在起来(或工作区正在打开)/ 连不上(离线、找不到它的会话)。 */
export type VoiceJobHeld = 'asleep' | 'waking' | 'unreachable'

export type VoiceNotesContext = {
  deviceId: string
  assistantId: string
  /** 此刻读写得了它家里的工作区;读写不了 = null。现读(❌ 用 App 最后一次渲染时的那个):离开 App 之后它睡了 / 醒了这里也知道。 */
  machine(): AssistantMachine | null
  /** machine() 为 null 时是哪一种。 */
  held(): VoiceJobHeld
}

export type VoiceJobPorts = {
  context(): VoiceNotesContext | null
  recorder: Pick<PhoneVoiceRecorder, 'start' | 'stop' | 'busy' | 'getSnapshot'>
  backlog: VoiceBacklog
  sleep(ms: number): Promise<void>
  now(): Date
  random(): string
  warn(fields: Record<string, unknown>, message: string): void
}

// ── 进度 ───────────────────────────────────────────────────────────────────────────

/** uploaded = 都传上去了,等桌面转写(手机这边的终点)。 */
export type VoiceJobPhase = 'recording' | 'uploading' | 'uploaded' | 'failed' | 'no_speech'

export type VoiceJobView = {
  id: string
  phase: VoiceJobPhase
  failure: VoiceNoteFailure | null
  /** 录音条上关掉了(进度照走,只是条子不再挂着)。 */
  dismissed: boolean
  createdAt: string
  /** 在等它家里能读写(录音留在手机上);null = 没在等。 */
  held: VoiceJobHeld | null
}

export type StartOutcome = 'started' | 'busy' | 'no_assistant' | 'cancelled' | RecorderError

type PendingSegment = {
  file: string
  /** 还在手机内存里的字节;传上去之后放掉。 */
  blob: Blob | null
  startMs: number
  durationMs: number
  voicedMs: number
  uploaded: boolean
}

type Job = {
  id: string
  deviceId: string
  assistantId: string
  meta: VoiceNoteMeta
  segments: PendingSegment[]
  recordingDone: boolean
  /** note.json 已经在它家里了。 */
  created: boolean
  running: boolean
  /** 删了 / 放弃了:不再往它家里写,也不再列出来。 */
  forgotten?: boolean
  /** 第几轮(kick 一次加一)。 */
  runs: number
  view: VoiceJobView
  /** 手机上留记录的写入串成一条,先后顺序不乱。 */
  persisting: Promise<void>
}

const MACHINE_POLL_MS = 1_000

export function createPhoneVoiceJobs(ports: VoiceJobPorts) {
  const jobs = new Map<string, Job>()
  let snapshot: readonly VoiceJobView[] = []
  const listeners = new Set<() => void>()

  function publish() {
    snapshot = [...jobs.values()].map((job) => job.view)
    for (const listener of listeners) listener()
  }

  function setView(job: Job, next: Partial<VoiceJobView>) {
    job.view = { ...job.view, ...next }
    publish()
  }

  // ── 手机上留的记录 ──────────────────────────────────────────────────────────────

  function toBacklog(job: Job): BacklogJob {
    return {
      id: job.id,
      deviceId: job.deviceId,
      assistantId: job.assistantId,
      meta: job.meta,
      segments: job.segments.map(({ file, startMs, durationMs, voicedMs, uploaded }) => ({ file, startMs, durationMs, voicedMs, uploaded })),
      recordingDone: job.recordingDone,
      created: job.created,
    }
  }

  /** 尽力而为:存不下只记日志,❌ 挡住录音与上传。 */
  function persist(job: Job, work?: () => Promise<void>) {
    job.persisting = job.persisting
      .then(async () => {
        if (job.forgotten) return
        await work?.()
        await ports.backlog.saveJob(toBacklog(job))
      })
      .catch((error: unknown) => ports.warn({ err: error, id: job.id }, '语音笔记的记录没能存在手机上'))
  }

  function drop(job: Job) {
    job.persisting = job.persisting.then(() => ports.backlog.dropJob(job.id)).catch((error: unknown) => ports.warn({ err: error, id: job.id }, '语音笔记的记录没能从手机上清掉'))
  }

  // ── 它家里的文件夹 ──────────────────────────────────────────────────────────────

  const noteDir = (machine: AssistantMachine, id: string) => joinPath(joinPath(machine.paths.memoryDir, VOICE_NOTES_DIR), id)

  async function saveMeta(job: Job, machine: AssistantMachine, patch: Partial<VoiceNoteMeta> = {}) {
    if (job.forgotten) throw new Error('forgotten')
    job.meta = {
      ...job.meta,
      ...patch,
      // 只记已经在它家里的段:没传上去的记进来,桌面接着转写时会去读一个不存在的文件。transcribed 一律 false:手机不转写。
      segments: job.segments.filter((s) => s.uploaded).map(({ file, startMs, durationMs, voicedMs }) => ({ file, startMs, durationMs, voicedMs, transcribed: false })),
      updatedAt: ports.now().toISOString(),
    }
    await writeText(machine, joinPath(noteDir(machine, job.id), VOICE_NOTE_META_FILE), serializeVoiceNoteMeta(job.meta))
  }

  async function ensureCreated(job: Job, machine: AssistantMachine) {
    if (job.created) return
    const root = await makeFolder(machine, machine.paths.memoryDir, VOICE_NOTES_DIR)
    if ((await readText(machine, joinPath(root, VOICE_NOTES_README_FILE))) === null) await writeText(machine, joinPath(root, VOICE_NOTES_README_FILE), voiceNotesReadme())
    const dir = await makeFolder(machine, root, job.id)
    await makeFolder(machine, dir, VOICE_NOTE_AUDIO_DIR)
    await saveMeta(job, machine)
    job.created = true
    persist(job)
  }

  // ── 干活 ───────────────────────────────────────────────────────────────────────────

  /** 等它家里能读写;睡着 ❌ 叫(手机的规矩),只在界面上说「录音留在手机上」,醒了自己接着传。 */
  async function waitMachine(job: Job): Promise<AssistantMachine> {
    for (;;) {
      if (job.forgotten) throw new Error('forgotten')
      const ctx = ports.context()
      const mine = ctx && ctx.assistantId === job.assistantId && ctx.deviceId === job.deviceId ? ctx : null
      const machine = mine?.machine() ?? null
      if (mine && machine) {
        if (job.view.held) setView(job, { held: null })
        return machine
      }
      const held: VoiceJobHeld = mine ? mine.held() : 'unreachable'
      if (job.view.held !== held) setView(job, { held })
      await ports.sleep(MACHINE_POLL_MS)
    }
  }

  async function run(job: Job) {
    try {
      for (;;) {
        const machine = await waitMachine(job)
        if (job.forgotten) return
        await ensureCreated(job, machine)
        const dir = noteDir(machine, job.id)

        const toUpload = job.segments.find((s) => !s.uploaded)
        if (toUpload) {
          if (job.recordingDone) setView(job, { phase: 'uploading' })
          const name = toUpload.file.slice(VOICE_NOTE_AUDIO_DIR.length + 1)
          try {
            await uploadFile(machine, joinPath(dir, VOICE_NOTE_AUDIO_DIR), new File([toUpload.blob!], name, { type: toUpload.blob!.type }))
          } catch (error) {
            throw error instanceof Error ? error : new Error(String(error))
          }
          toUpload.uploaded = true
          toUpload.blob = null
          // 录着时记 recording,录完了还在传记 transcribing(核心格式里「录完了,在传 / 在转写」同一格,都是「处理中」)。
          await saveMeta(job, machine, job.recordingDone ? { status: 'transcribing' } : {})
          // 传上去了:先把「已传」记下,再把手机上留的那份字节放掉(存储里只留「还没传的」;反过来,中间被杀就丢了一段)。
          persist(job)
          job.persisting = job.persisting
            .then(() => ports.backlog.dropSegment(job.id, toUpload.file))
            .catch((error: unknown) => ports.warn({ err: error, id: job.id }, '传完的语音笔记片段没能从手机上清掉'))
          continue
        }

        // 没录完:等下一段(addSegment 会再 kick)。
        if (!job.recordingDone) return

        // 录完了、都传上去了。有声不到阈值(与桌面同一个)= 未检测到语音,不必等人转写;否则停在「已传上去、待转写」。
        const voiced = job.segments.reduce((n, s) => n + s.voicedMs, 0)
        if (voiced < VOICE_NOTE_MIN_TOTAL_VOICED_MS) {
          await saveMeta(job, machine, { status: 'no_speech', failure: null })
          setView(job, { phase: 'no_speech' })
        } else {
          await saveMeta(job, machine, { status: 'uploaded', failure: null })
          setView(job, { phase: 'uploaded' })
        }
        drop(job)
        return
      }
    } catch (error) {
      if (job.forgotten) return
      const failure: VoiceNoteFailure = { stage: 'upload', message: error instanceof Error ? error.message : String(error), retryable: true }
      // 界面只说「无法上传」;原因(哪一步、那台机器答的什么)进日志,❌ 画给用户。
      ports.warn({ id: job.id, err: error instanceof Error ? error.message : String(error), segments: job.segments.length }, '语音笔记没能传上去')
      // 先放开「在跑」:失败记进它家里那一下可能要等很久(多半正是它连不上),这期间点「重试」要立刻生效。
      job.running = false
      setView(job, { phase: 'failed', failure, dismissed: false, held: null })
      const machine = ports.context()?.machine() ?? null
      if (machine && job.created) void saveMeta(job, machine, { status: 'failed', failure }).catch(() => undefined)
    }
  }

  function kick(job: Job) {
    if (job.running || job.forgotten) return
    job.running = true
    const token = (job.runs += 1)
    void run(job).finally(() => {
      // 失败时 run 自己先放开了;那之后人点了重试又起了一轮,这里 ❌ 把新那一轮的标记抹掉。
      if (job.runs === token) job.running = false
    })
  }

  // ── 录 ─────────────────────────────────────────────────────────────────────────────

  function newJob(input: { id: string; deviceId: string; assistantId: string; meta: VoiceNoteMeta }): Job {
    return {
      id: input.id,
      deviceId: input.deviceId,
      assistantId: input.assistantId,
      meta: input.meta,
      segments: [],
      recordingDone: false,
      created: false,
      running: false,
      runs: 0,
      persisting: Promise.resolve(),
      view: { id: input.id, phase: 'recording', failure: null, dismissed: false, createdAt: input.meta.createdAt, held: null },
    }
  }

  function addSegment(job: Job, segment: RecordedSegment) {
    if (job.forgotten) return
    const file = segmentFileName(segment.index, segment.extension)
    job.segments.push({ file, blob: segment.blob, startMs: segment.startMs, durationMs: segment.durationMs, voicedMs: segment.voicedMs, uploaded: false })
    job.segments.sort((a, b) => a.startMs - b.startMs)
    persist(job, () => ports.backlog.saveSegment(job.id, file, segment.blob))
    // 录着录着传失败了(网断了一下):新的一段来了就接着试,❌ 等人点重试。
    if (job.view.phase === 'failed' && !job.recordingDone) {
      job.meta = { ...job.meta, status: 'recording', failure: null }
      setView(job, { phase: 'recording', failure: null })
    }
    kick(job)
  }

  function finishRecording(job: Job, durationMs: number) {
    if (job.forgotten) return
    job.recordingDone = true
    job.meta = { ...job.meta, durationMs, endedAt: ports.now().toISOString(), status: 'transcribing', failure: null }
    setView(job, { phase: 'uploading' })
    persist(job)
    kick(job)
  }

  async function start(meeting?: VoiceNoteMeta['meeting']): Promise<StartOutcome> {
    const ctx = ports.context()
    if (!ctx) return 'no_assistant'
    if (ports.recorder.busy) return 'busy'
    let job: Job | null = null
    const started = await ports.recorder.start({
      onSegment: (segment) => {
        if (job) addSegment(job, segment)
      },
      // 麦克风半路没了(interrupted):已录的照常传;录音机那边留着原因,录音条提示一句。
      onEnd: ({ durationMs }) => {
        if (job) finishRecording(job, durationMs)
      },
    })
    // 没开成又没有原因 = 人在「正在开始录音…」时点了取消。
    if (!started) return ports.recorder.getSnapshot().error ?? 'cancelled'
    const now = ports.now()
    const id = voiceNoteId(now, ports.random())
    const meta = newVoiceNoteMeta({ id, createdAt: now, source: 'phone', meeting: meeting ?? null })
    job = newJob({ id, deviceId: ctx.deviceId, assistantId: ctx.assistantId, meta })
    jobs.set(id, job)
    publish()
    persist(job)
    kick(job)
    return 'started'
  }

  // ── 重试 / 放弃 / 接着做 ─────────────────────────────────────────────────────────

  /** 录音条上的「重试」:从卡住的那一步(传)接着做。 */
  function retry(id: string) {
    const job = jobs.get(id)
    if (!job || job.running) return
    job.meta = { ...job.meta, failure: null, status: job.recordingDone ? 'transcribing' : 'recording' }
    setView(job, { phase: job.recordingDone ? 'uploading' : 'recording', failure: null, dismissed: false })
    persist(job)
    kick(job)
  }

  /** 录音条:关掉一条(进度照走)。 */
  function dismiss(id: string) {
    const job = jobs.get(id)
    if (job) setView(job, { dismissed: true })
  }

  /**
   * 放弃这一条:还在录就停下,录下的不要了;手机上留的记录、它家里已经建出来的那一夹一并清掉(清不掉的留在列表里,人能删)。
   * ❌ 让它再把文件写回去。
   */
  function discard(id: string) {
    const job = jobs.get(id)
    if (!job) return
    job.forgotten = true
    if (!job.recordingDone) ports.recorder.stop()
    jobs.delete(id)
    publish()
    job.persisting = job.persisting
      .then(() => ports.backlog.dropJob(id))
      .catch((error: unknown) => ports.warn({ err: error, id }, '语音笔记的记录没能从手机上清掉'))
    const machine = ports.context()?.machine() ?? null
    if (machine && job.created) void removePath(machine, noteDir(machine, id), true).catch((error: unknown) => ports.warn({ err: error, id }, '放弃的语音笔记没能从它家里删掉'))
  }

  /** 进程重新起来:把手机上还留着的(没传完的)按记录接着传。没录完就被杀的当作录到那儿为止。 */
  async function restore(assistantId: string): Promise<void> {
    let stored: BacklogJob[]
    try {
      stored = await ports.backlog.list()
    } catch (error) {
      ports.warn({ err: error }, '读不出手机上留的语音笔记记录')
      return
    }
    for (const record of stored) {
      if (record.assistantId !== assistantId || jobs.has(record.id)) continue
      const meta = record.meta as VoiceNoteMeta
      const segments: PendingSegment[] = []
      for (const s of record.segments) {
        let blob: Blob | null = null
        if (!s.uploaded) {
          blob = await ports.backlog.readSegment(record.id, s.file).catch(() => null)
          // 没传上去、手机上的字节也没了:这一段救不回来,❌ 留着让上传卡在读不到的文件上。
          if (!blob) {
            ports.warn({ id: record.id, file: s.file }, '语音笔记有一段手机上的字节没了,跳过它')
            continue
          }
        }
        segments.push({ ...s, blob })
      }
      const durationMs = meta.durationMs || segments.reduce((n, s) => Math.max(n, s.startMs + s.durationMs), 0)
      const job = newJob({ id: record.id, deviceId: record.deviceId, assistantId: record.assistantId, meta: { ...meta, durationMs, failure: null, status: 'transcribing' } })
      job.segments = segments
      job.recordingDone = true
      job.created = record.created
      job.view = { ...job.view, phase: 'uploading', createdAt: meta.createdAt }
      jobs.set(job.id, job)
      publish()
      kick(job)
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    get: (id: string) => jobs.get(id)?.view ?? null,
    start,
    retry,
    dismiss,
    discard,
    restore,
  }
}

export type PhoneVoiceJobs = ReturnType<typeof createPhoneVoiceJobs>
