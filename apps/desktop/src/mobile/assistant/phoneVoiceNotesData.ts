// #7199 手机上看语音笔记(只读;录、转写都在电脑那一侧):<记忆夹>/voice-notes/<id>/ 每条一夹,格式见 @gugu/core/shared/voiceNotes。
// 读法照桌面 voice-notes-data.ts,少两样:没有本机正在跑的进度可叠(手机录的那条进度在录音条上,列表只读文件),也 ❌ 往 note.json 回写标题(那是写的那一端的事)。
import {
  parseTranscript,
  parseVoiceNoteMeta,
  summaryTitle,
  voiceNoteView,
  VOICE_NOTE_META_FILE,
  VOICE_NOTE_SUMMARY_FILE,
  VOICE_NOTE_TRANSCRIPT_FILE,
  type TranscriptLine,
  type VoiceNoteMeta,
  type VoiceNoteView,
} from '@gugu/core/shared/voiceNotes'
import { joinPath } from '@/session/renderer/features/assistant/assistant-files'
import { listDirectory, readText, removePath, type AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { voiceNotesDirOf } from './phoneMemoryData'

export type PhoneVoiceItem = {
  id: string
  /** note.json 读不出来 = null(仍列出来,能删)。 */
  meta: VoiceNoteMeta | null
  view: VoiceNoteView
  title: string | null
  createdAt: string
}

export type PhoneVoiceDetail = { item: PhoneVoiceItem; summary: string | null; lines: TranscriptLine[] }

export function voiceNoteDirOf(machine: AssistantMachine, id: string): string {
  return joinPath(voiceNotesDirOf(machine), id)
}

/** id 是录音开始的时刻(voiceNoteId);note.json 读不出来时拿它排序。 */
export function createdFromId(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).toISOString() : ''
}

async function readItem(machine: AssistantMachine, id: string, now: number): Promise<PhoneVoiceItem> {
  const dir = voiceNoteDirOf(machine, id)
  const meta = parseVoiceNoteMeta((await readText(machine, joinPath(dir, VOICE_NOTE_META_FILE))) ?? '')
  if (!meta) {
    return {
      id,
      meta: null,
      view: { kind: 'failed', stage: 'transcribe', retryable: false, message: 'unreadable', notice: null, code: null },
      title: null,
      createdAt: createdFromId(id),
    }
  }
  // 交给它写总结之后、note.json 还没标好:summary.md 已经在了就算好了(标题取它的第一行)。
  let summary: string | undefined
  if (meta.status === 'summarizing' || meta.status === 'failed') {
    const text = await readText(machine, joinPath(dir, VOICE_NOTE_SUMMARY_FILE))
    summary = text?.trim() ? summaryTitle(text) : undefined
  }
  const view = voiceNoteView(meta, summary, now)
  return { id, meta, view, title: view.kind === 'ready' ? view.title : meta.title, createdAt: meta.createdAt }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await fn(items[index]!)
      }
    }),
  )
  return out
}

/** 全部语音笔记(夹子还没有 = 空)。 */
export async function readVoiceNotes(machine: AssistantMachine, now = Date.now()): Promise<PhoneVoiceItem[]> {
  const entries = await listDirectory(machine, voiceNotesDirOf(machine))
  const dirs = entries.filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
  return mapLimit(dirs, 6, (entry) => readItem(machine, entry.name, now))
}

/** 一条:note.json 不在了 = null(被删了);总结、转写各读各的。 */
export async function readVoiceNote(machine: AssistantMachine, id: string, now = Date.now()): Promise<PhoneVoiceDetail | null> {
  const dir = voiceNoteDirOf(machine, id)
  if ((await readText(machine, joinPath(dir, VOICE_NOTE_META_FILE))) === null) return null
  const [item, summary, transcript] = await Promise.all([
    readItem(machine, id, now),
    readText(machine, joinPath(dir, VOICE_NOTE_SUMMARY_FILE)),
    readText(machine, joinPath(dir, VOICE_NOTE_TRANSCRIPT_FILE)),
  ])
  return { item, summary: summary?.trim() ? summary : null, lines: transcript ? parseTranscript(transcript) : [] }
}

export function deleteVoiceNote(machine: AssistantMachine, id: string): Promise<void> {
  return removePath(machine, voiceNoteDirOf(machine, id), true)
}

/** 还在处理的那几条 5 秒再看一眼(照桌面),其余 30 秒。 */
export function voicePollMs(processing: boolean): number {
  return processing ? 5_000 : 30_000
}

/** 失败那一句(照桌面 failureText):网关明说的原话 > 签票原因码的那一句 > 按环节的通用一句。 */
const FAILURE_CODES = new Set(['signed-out', 'membership-required', 'model-unavailable', 'unreachable', 'service-unavailable'])
export function voiceFailureText(
  t: (key: string, values?: Record<string, string>) => string,
  view: { stage: string; notice: string | null; code: string | null; message: string },
  name: string,
): string {
  if (view.notice) return view.notice
  if (view.code && FAILURE_CODES.has(view.code)) return t(`failure.code.${view.code}`)
  if (view.message === 'unreadable') return t('failure.unreadable')
  return t(`failure.${view.stage}`, { name })
}
