// #7199 手机录的语音笔记传上来后停在 uploaded(等转写),桌面点「开始转写」= 现成的 retryVoiceNote:
// 从 note.json 重建一条任务 → 读回云上的 .wav → 转写 → 写 transcript.md → 交给助理写总结 → 写好就好了。
// 桌面零改动:这里用 voice-note-jobs 现有的可注入点(上下文、IPC、那台机器的线)跑真的 retryVoiceNote,
// 只把「解码成 WAV」(WebView 的 OfflineAudioContext)换成直通 —— 手机写的就是 16k 单声道 WAV。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseVoiceNoteMeta, renderTranscript, serializeVoiceNoteMeta, voiceNoteView, type VoiceNoteMeta } from '@gugu/core/shared/voiceNotes'
import { assistantPaths } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-files'
import type { AssistantMachine, MachineRpc } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'

const mocks = vi.hoisted(() => ({
  invokeOnMachine: vi.fn(),
  sendMessage: vi.fn(),
  readChunk: vi.fn(),
  decoded: [] as number[],
}))

vi.mock('@renderer/lib/ipc', () => ({
  invokeOnMachine: (...args: unknown[]) => mocks.invokeOnMachine(...args),
  rpcOn: () => ({
    workspace: { files: { readChunk: (...args: unknown[]) => mocks.readChunk(...args) } },
    sessions: { sendMessage: (...args: unknown[]) => mocks.sendMessage(...args) },
  }),
  rpc: {},
}))
// 它家那台上的会话目录(助理自己那条会话从这里认):只给一条,别的与这里无关。
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({
  homeTarget: (home: { deviceId: string }) => home.deviceId,
  homeSessions: () => ({ sessions: [{ agent: { userId: 'assistant-1' }, projectId: 'p1', conversationId: 'assistant-session' }], live: true }),
  localHomeSessions: { use: () => () => undefined, sessions: [], loaded: true },
}))
// 桌面那层 assistant-machine 在核心之上还拖进整个应用状态(挂本机项目用);这里只要读写核心。
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine', async () => await import('../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'))
// 列表那一层只用它的查询键;整个模块会拖进浏览器标签页那一串,与这里无关。
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({
  assistantQueryKey: (deviceId: string, ...parts: unknown[]) => ['assistant', deviceId, ...parts],
}))
// 解码交给 WebView 的 OfflineAudioContext(node 里没有):手机录的已经是 WAV,这里直通,只记「解码被问到了几个字节」。
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-note-audio', async (importActual) => {
  const actual = await importActual<typeof import('../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-note-audio')>()
  return {
    ...actual,
    segmentToWavBase64: async (blob: Blob) => {
      mocks.decoded.push(blob.size)
      return `WAV:${blob.size}`
    },
  }
})

const jobsModule = await import('../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-note-jobs')
const dataModule = await import('../../../apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-notes-data')
const { retryVoiceNote, setVoiceNotesContext, voiceJobs } = jobsModule

const HOME = '/home/u'
const paths = assistantPaths(HOME, '/home/u/assistant')
const NOTES = `${paths.memoryDir}/voice-notes`
const ID = '20261016-090000-ab12'
const DIR = `${NOTES}/${ID}`
const AUDIO = new Uint8Array(1234).fill(7)

/** 手机写的那份 note.json:录完、都传上去了、没人转写。 */
function phoneNote(patch: Partial<VoiceNoteMeta> = {}): VoiceNoteMeta {
  return {
    version: 1,
    id: ID,
    createdAt: '2026-10-16T09:00:00.000Z',
    endedAt: '2026-10-16T09:10:00.000Z',
    durationMs: 600_000,
    source: 'phone',
    status: 'uploaded',
    failure: null,
    title: null,
    segments: [
      { file: 'audio/000.wav', startMs: 0, durationMs: 300_000, voicedMs: 20_000, transcribed: false },
      { file: 'audio/001.wav', startMs: 300_000, durationMs: 300_000, voicedMs: 15_000, transcribed: false },
    ],
    summaryRequestedAt: null,
    updatedAt: '2026-10-16T09:10:05.000Z',
    meeting: null,
    ...patch,
  }
}

function fakeHome() {
  const text = new Map<string, string>()
  const uploads: string[] = []
  const rpc = {
    workspace: {
      files: {
        readExternalFile: async (_p: string, _w: string, path: string) => {
          const content = text.get(path)
          if (content === undefined) return { success: false, error: { type: 'fs_error', message: `ENOENT: no such file or directory, open '${path}'` } }
          return { success: true, data: { content, truncated: false, totalSize: content.length } }
        },
        writeExternalFile: async (_p: string, _w: string, path: string, content: string) => {
          text.set(path, content)
          return { success: true, data: {} }
        },
        createEntry: async (_p: string, _w: string, dir: string, name: string) => ({ success: true, data: { path: `${dir}/${name}` } }),
        writeChunk: async (_p: string, _w: string, chunk: { path: string }) => {
          uploads.push(chunk.path)
          return { success: true, data: {} }
        },
      },
    },
  }
  const machine: AssistantMachine = { deviceId: 'cloud', target: 'cloud', rpc: rpc as unknown as MachineRpc, home: HOME, projectId: 'p1', workspaceId: 'w1', paths }
  return { machine, text, uploads }
}

const REPLY = '[00:02] 说话人1：我们先对一下发布时间\n[00:09] 说话人2：周四上线'

beforeEach(() => {
  mocks.decoded.length = 0
  mocks.invokeOnMachine.mockReset()
  mocks.sendMessage.mockReset()
  mocks.readChunk.mockReset()
  // 云上的音频:任意一段都读回同样 1234 字节。
  mocks.readChunk.mockImplementation(async (_p: string, _w: string, { offset, length }: { offset: number; length: number }) => {
    const slice = AUDIO.slice(offset, offset + length)
    return { success: true, data: { data: Buffer.from(slice).toString('base64'), size: AUDIO.length } }
  })
})
afterEach(() => {
  setVoiceNotesContext(null)
  voiceJobs.forget(ID)
})

describe('桌面「开始转写」= retryVoiceNote:手机传上来的 uploaded 笔记接着转写、交总结', () => {
  it('列表上它是「等转写」(queued),不是处理中也不会过期判失败;点开始后本窗口的进度盖过文件、变成处理中', async () => {
    const home = fakeHome()
    const meta = phoneNote()
    // 读回来的就是手机写的那份。
    const view = voiceNoteView(parseVoiceNoteMeta(serializeVoiceNoteMeta(meta))!, undefined, Date.parse(meta.updatedAt) + 6 * 3_600_000)
    expect(view).toEqual({ kind: 'queued' })

    home.text.set(`${DIR}/note.json`, serializeVoiceNoteMeta(meta))
    mocks.invokeOnMachine.mockResolvedValue({ ok: true, text: REPLY })
    mocks.sendMessage.mockImplementation(async () => {
      home.text.set(`${DIR}/summary.md`, '# 发布时间对齐\n\n- 周四上线')
      return { id: 'm1', status: 'delivered' }
    })
    setVoiceNotesContext({ deviceId: 'cloud', home: { kind: 'cloud', deviceId: 'cloud' }, assistantId: 'assistant-1', ownerName: '小明', machine: home.machine, readiness: () => 'ready', wake: vi.fn(), invalidate: vi.fn() })
    const phases: string[] = []
    const stop = voiceJobs.subscribe(() => phases.push(voiceJobs.get(ID)?.phase ?? 'none'))

    await retryVoiceNote(ID)
    const item = { id: ID, meta, view, title: null, createdAt: meta.createdAt }
    // 本窗口有它的进度了:列表 / 详情以它为准(处理中),❌ 还说「等转写」。
    expect(dataModule.effectiveView(item, voiceJobs.getSnapshot())).toMatchObject({ kind: 'processing' })

    await vi.waitFor(() => expect(voiceJobs.get(ID)?.phase).toBe('ready'), { timeout: 3_000, interval: 5 })
    stop()

    // 转写从「转写」补起(❌ 直接去交总结):第一个进度就是 transcribing。
    expect(phases[0]).toBe('transcribing')
    // 读回的是云上那两段 .wav,没有重新上传。
    expect(home.uploads).toEqual([])
    expect(mocks.decoded).toEqual([AUDIO.length, AUDIO.length])
    // 每段各转写一次,以助理的名义,音频 = 读回来的那份,第二段的起点接在第一段后面。
    expect(mocks.invokeOnMachine).toHaveBeenCalledTimes(3) // 两段转写 + 一次放票
    const calls = mocks.invokeOnMachine.mock.calls as [null, string, { agentUserId: string; audioBase64: string; prompt: string } | string][]
    expect(calls[0]![1]).toBe('voice-notes:transcribe')
    expect(calls[0]![2]).toMatchObject({ agentUserId: 'assistant-1', audioBase64: `WAV:${AUDIO.length}` })
    expect(calls[1]![1]).toBe('voice-notes:transcribe')
    expect(calls[2]![1]).toBe('voice-notes:release')
    // 写进 transcript.md:第二段的时间接着第一段(300s 起)。
    const transcript = home.text.get(`${DIR}/transcript.md`) ?? ''
    expect(transcript).toContain('[00:02] 说话人 1：我们先对一下发布时间')
    expect(transcript).toContain('[05:02] 说话人 1：我们先对一下发布时间')
    expect(transcript).toBe(
      renderTranscript([
        { startMs: 2_000, speaker: '说话人 1', text: '我们先对一下发布时间' },
        { startMs: 9_000, speaker: '说话人 2', text: '周四上线' },
        { startMs: 302_000, speaker: '说话人 1', text: '我们先对一下发布时间' },
        { startMs: 309_000, speaker: '说话人 2', text: '周四上线' },
      ])
    )
    // 交给助理自己那条会话(session-direct),话里带着这一条的文件夹。
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage.mock.calls[0]![0]).toMatchObject({ projectId: 'p1', sessionId: 'assistant-session', kind: 'session-direct' })
    expect(mocks.sendMessage.mock.calls[0]![0].text).toContain(`${DIR}/summary.md`)
    // 它写好了就是好了:note.json 标 ready、带标题;段都标转写过。
    const done = parseVoiceNoteMeta(home.text.get(`${DIR}/note.json`) ?? '')!
    expect(done).toMatchObject({ status: 'ready', title: '发布时间对齐', source: 'phone' })
    expect(done.segments.every((s) => s.transcribed)).toBe(true)
  })

  it('没转写过的段就是「欠着」:uploaded 的笔记重试一定走转写,❌ 当成只差交总结', async () => {
    const { retryStartsAt } = await import('@gugu/core/shared/voiceNotes')
    expect(retryStartsAt(phoneNote())).toBe('transcribe')
  })
})
