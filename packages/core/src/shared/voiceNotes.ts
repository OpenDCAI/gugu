// #7199 语音笔记:录下的会议 / 语音交给云电脑上的个人助理,转写、它从主人的角度写总结,
// 放在云电脑上「记忆」那一夹里(换台电脑登录也看得到)。这一份是**桌面与手机共用的格式**:谁录的都照这里写文件,
// 谁看的都照这里读 —— 文件夹怎么排、每个文件长什么样、状态怎么判、交给助理的那段话、导出的 Markdown。
//
//   <记忆夹>/voice-notes/
//     README.md                 给助理看的说明(这一夹是什么、它要做什么)
//     <id>/note.json            这条的元数据与进度(录的那一端维护)
//     <id>/audio/000.webm …     录音,每 5 分钟一段(每段自己能单独解码;手机是 000.wav:16k 单声道 16 位,就是送去转写的那份)
//     <id>/transcript.md        转写:每行「[mm:ss] 说话人 N：内容」
//     <id>/summary.md           助理写的总结,第一行「# 标题」
//
// 谁做到哪一步:桌面(source 'desktop')自己录、传、转写、交给助理写总结。手机(source 'phone')只录和传 ——
// 传完就停在 status 'uploaded'(列表上「等转写」,视图 queued),转写由桌面咕咕里的「开始转写」接着做
// (读回云上的音频 → 转写 → 交给助理写总结,与重试同一条路)。旧版客户端读到不认识的状态会落进 failed(可重试),
// 兼容上可以接受。
//
// 只放纯函数(可单测);读写云电脑在各端自己的那一层。

export const VOICE_NOTES_DIR = 'voice-notes'
export const VOICE_NOTE_META_FILE = 'note.json'
export const VOICE_NOTE_TRANSCRIPT_FILE = 'transcript.md'
export const VOICE_NOTE_SUMMARY_FILE = 'summary.md'
export const VOICE_NOTE_AUDIO_DIR = 'audio'
export const VOICE_NOTES_README_FILE = 'README.md'

/** 一段录音多长:5 分钟一段,单段 16k 单声道 WAV ≈ 9.6MB,base64 后仍在网关 32MB 的请求上限以内。 */
export const VOICE_NOTE_SEGMENT_MS = 5 * 60_000
/** 一段里有声的时间不到这么多就不送去转写(静音段送进模型会编出字来)。 */
export const VOICE_NOTE_MIN_SEGMENT_VOICED_MS = 400
/** 整条有声的时间不到这么多 = 未检测到语音(skipped / no_usable_speech)。 */
export const VOICE_NOTE_MIN_TOTAL_VOICED_MS = 1_500
/** 交给助理之后这么久还没有总结 = 失败(可重试)。 */
export const VOICE_NOTE_SUMMARY_TIMEOUT_MS = 10 * 60_000
/** 录 / 传 / 转写中的那一端这么久没再写进度 = 那一端已经不在了(关了 App、断了网):如实说失败,给重试。 */
export const VOICE_NOTE_STALE_MS = 15 * 60_000

export type VoiceNoteStatus =
  /** 正在录(录的那一端每传完一段写一次进度)。 */
  | 'recording'
  /** 录完了,在传 / 在转写。 */
  | 'transcribing'
  /** 录完了、段都传上去了、还没人转写(手机只做到这一步,等桌面「开始转写」)。 */
  | 'uploaded'
  /** 转写好了,交给助理写总结。 */
  | 'summarizing'
  | 'ready'
  | 'failed'
  /** 整段没有可用的人声。 */
  | 'no_speech'

export type VoiceNoteFailureStage = 'upload' | 'transcribe' | 'summarize'

/**
 * `message` = 内部原因(进日志、给排查的人看,❌ 原样画给用户);`notice` = 网关明说给人听的那句(积分用完 ——
 * 「谁拒绝谁说话」);`code` = 签票那一步的原因码(没登录、要开会员、连不上……),界面按它说一句。
 * 界面:有 notice 画 notice,有认得的 code 说那一句,都没有就按 stage 说一句通用的。
 */
export type VoiceNoteFailure = { stage: VoiceNoteFailureStage; message: string; retryable: boolean; notice?: string | null; code?: string | null }

export type VoiceNoteSegment = {
  /** 相对这条笔记的文件夹,如 `audio/000.webm`。 */
  file: string
  /** 这一段从整条录音的第几毫秒开始(暂停不算时间)。 */
  startMs: number
  durationMs: number
  /** 这一段里有人声的毫秒数(录的那一端估的);太少就不送转写。 */
  voicedMs: number
  transcribed: boolean
}

export type VoiceNoteMeta = {
  version: 1
  id: string
  createdAt: string
  endedAt: string | null
  durationMs: number
  source: 'desktop' | 'phone'
  status: VoiceNoteStatus
  failure: VoiceNoteFailure | null
  /** 总结出来之后从 summary.md 的标题抄过来(列表不用每条都去读总结)。 */
  title: string | null
  segments: VoiceNoteSegment[]
  /** 交给助理的那一刻;超时判失败从这里算。 */
  summaryRequestedAt: string | null
  updatedAt: string
  /** 从会议提醒开始录的:那场会。 */
  meeting?: { title: string; start: string; end: string | null } | null
}

const STATUSES: readonly VoiceNoteStatus[] = ['recording', 'transcribing', 'uploaded', 'summarizing', 'ready', 'failed', 'no_speech']

/** `20261015-183000-ab12`:按时间排得开,同一秒两条也不撞。 */
export function voiceNoteId(at: Date, random: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${stamp}-${random.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 4).padEnd(4, '0')}`
}

export function segmentFileName(index: number, extension = 'webm'): string {
  return `${VOICE_NOTE_AUDIO_DIR}/${String(index).padStart(3, '0')}.${extension}`
}

export function newVoiceNoteMeta(input: { id: string; createdAt: Date; source: VoiceNoteMeta['source']; meeting?: VoiceNoteMeta['meeting'] }): VoiceNoteMeta {
  const iso = input.createdAt.toISOString()
  return {
    version: 1,
    id: input.id,
    createdAt: iso,
    endedAt: null,
    durationMs: 0,
    source: input.source,
    status: 'recording',
    failure: null,
    title: null,
    segments: [],
    summaryRequestedAt: null,
    updatedAt: iso,
    meeting: input.meeting ?? null,
  }
}

/** 读 note.json;认不出(坏了、别的版本)= null,调用方当成「这条读不出来」而不是丢掉。 */
export function parseVoiceNoteMeta(text: string): VoiceNoteMeta | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (row.version !== 1 || typeof row.id !== 'string' || typeof row.createdAt !== 'string') return null
  const status = STATUSES.find((s) => s === row.status) ?? 'failed'
  const failure = row.failure && typeof row.failure === 'object' ? (row.failure as Record<string, unknown>) : null
  const segments = Array.isArray(row.segments)
    ? row.segments.flatMap((entry): VoiceNoteSegment[] => {
        if (!entry || typeof entry !== 'object') return []
        const s = entry as Record<string, unknown>
        if (typeof s.file !== 'string') return []
        return [{
          file: s.file,
          startMs: num(s.startMs),
          durationMs: num(s.durationMs),
          voicedMs: num(s.voicedMs),
          transcribed: s.transcribed === true,
        }]
      })
    : []
  const meeting = row.meeting && typeof row.meeting === 'object' ? (row.meeting as Record<string, unknown>) : null
  return {
    version: 1,
    id: row.id,
    createdAt: row.createdAt,
    endedAt: typeof row.endedAt === 'string' ? row.endedAt : null,
    durationMs: num(row.durationMs),
    source: row.source === 'phone' ? 'phone' : 'desktop',
    status,
    failure: failure
      ? {
          stage: failure.stage === 'upload' || failure.stage === 'summarize' ? failure.stage : 'transcribe',
          message: typeof failure.message === 'string' ? failure.message : '',
          retryable: failure.retryable !== false,
          notice: typeof failure.notice === 'string' && failure.notice.trim() ? failure.notice.trim() : null,
          code: typeof failure.code === 'string' && failure.code ? failure.code : null,
        }
      : null,
    title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null,
    segments,
    summaryRequestedAt: typeof row.summaryRequestedAt === 'string' ? row.summaryRequestedAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : row.createdAt,
    meeting: meeting && typeof meeting.title === 'string' && typeof meeting.start === 'string'
      ? { title: meeting.title, start: meeting.start, end: typeof meeting.end === 'string' ? meeting.end : null }
      : null,
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function serializeVoiceNoteMeta(meta: VoiceNoteMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

// ── 看的那一端:这条此刻算什么状态 ────────────────────────────────────────────────

/** 列表 / 详情要画的那一种(处理中 / 失败 / 未检测到语音 / 就绪)。 */
export type VoiceNoteView =
  | { kind: 'ready'; title: string | null }
  | { kind: 'processing'; phase: 'recording' | 'uploading' | 'transcribing' | 'summarizing' }
  /** 录音都在云电脑上了,还没转写(手机录的):等人在桌面点「开始转写」。 */
  | { kind: 'queued' }
  | { kind: 'failed'; stage: VoiceNoteFailureStage; retryable: boolean; message: string; notice: string | null; code: string | null }
  | { kind: 'no_speech' }

/**
 * 只看云电脑上的文件判状态(本机正在跑的那一条由调用方拿本机进度盖过它):
 * - 有 summary.md 就是好了(助理写完了,哪怕 note.json 还没来得及改);
 * - 手机录完传完(uploaded)= 等转写,❌ 当「处理中」也 ❌ 按 15 分钟判失败;
 * - 还在录 / 转写,但那一端很久没写进度 = 那一端不在了 → 失败(可重试),❌ 一直「处理中」;
 * - 交给助理太久没回 → 失败(可重试)。
 */
export function voiceNoteView(meta: VoiceNoteMeta, summaryTitle: string | null | undefined, now: number): VoiceNoteView {
  if (summaryTitle !== undefined && summaryTitle !== null) return { kind: 'ready', title: summaryTitle || meta.title }
  if (meta.status === 'ready') return { kind: 'ready', title: meta.title }
  if (meta.status === 'no_speech') return { kind: 'no_speech' }
  // 在等人点「开始转写」,不是谁卡住了:❌ 按 stale 判失败。
  if (meta.status === 'uploaded') return { kind: 'queued' }
  if (meta.status === 'failed') {
    const failure = meta.failure ?? { stage: 'transcribe', message: '', retryable: true }
    return { kind: 'failed', stage: failure.stage, retryable: failure.retryable, message: failure.message, notice: failure.notice ?? null, code: failure.code ?? null }
  }
  if (meta.status === 'summarizing') {
    const asked = Date.parse(meta.summaryRequestedAt ?? meta.updatedAt)
    if (Number.isFinite(asked) && now - asked > VOICE_NOTE_SUMMARY_TIMEOUT_MS)
      return { kind: 'failed', stage: 'summarize', retryable: true, message: 'timeout', notice: null, code: null }
    return { kind: 'processing', phase: 'summarizing' }
  }
  const touched = Date.parse(meta.updatedAt)
  if (Number.isFinite(touched) && now - touched > VOICE_NOTE_STALE_MS)
    return { kind: 'failed', stage: meta.status === 'recording' ? 'upload' : 'transcribe', retryable: true, message: 'stale', notice: null, code: null }
  return { kind: 'processing', phase: meta.status === 'recording' ? 'recording' : 'transcribing' }
}

/** 重试从哪一步接着做:转写全齐了就只再交一次给助理,否则把没转写的段补上。 */
export function retryStartsAt(meta: VoiceNoteMeta): 'transcribe' | 'summarize' {
  const pending = meta.segments.some((s) => !s.transcribed && s.voicedMs >= VOICE_NOTE_MIN_SEGMENT_VOICED_MS)
  return pending || meta.segments.length === 0 ? 'transcribe' : 'summarize'
}

// ── 列表:按周分组(周一起算,本周 / 上周 / 9月7日–13日) ─────────────────────────

export type VoiceNoteWeek = { key: string; kind: 'thisWeek' | 'lastWeek' | 'range'; start: Date; end: Date }

export function weekStart(at: Date): Date {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

export function groupVoiceNotesByWeek<T>(items: readonly T[], timeOf: (item: T) => string, now: Date): { week: VoiceNoteWeek; items: T[] }[] {
  const current = weekStart(now).getTime()
  const groups = new Map<number, T[]>()
  const sorted = [...items].sort((a, b) => timeOf(b).localeCompare(timeOf(a)))
  for (const item of sorted) {
    const at = new Date(timeOf(item))
    const key = Number.isNaN(at.getTime()) ? 0 : weekStart(at).getTime()
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, list]) => {
      const start = new Date(key)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)
      const weeksAgo = Math.round((current - key) / (7 * 86_400_000))
      const kind: VoiceNoteWeek['kind'] = weeksAgo <= 0 ? 'thisWeek' : weeksAgo === 1 ? 'lastWeek' : 'range'
      return { week: { key: String(key), kind, start, end }, items: list }
    })
}

// ── 转写:模型回的行 → 段;段 ↔ transcript.md ─────────────────────────────────────

export type TranscriptLine = { startMs: number; speaker: string; text: string }

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
}

/** 录音条上的计时:HH:MM:SS。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`
}

const LINE = /^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^：:\n]{1,40}?)\s*[：:]\s*(.*)$/

function stampMs(a: string, b: string, c: string | undefined): number {
  return c === undefined ? (Number(a) * 60 + Number(b)) * 1000 : (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000
}

/** 「说话人1」「Speaker 2」「说话人 3」都写成「说话人 N」;别的名字(助理认出来的人名)原样留。 */
export function normalizeSpeaker(raw: string): string {
  const m = /^(?:说话人|发言人|speaker)\s*(\d+)$/i.exec(raw.trim())
  return m ? `说话人 ${Number(m[1])}` : raw.trim()
}

/**
 * 模型回的那段字 → 行。`offsetMs` = 这一段在整条录音里从哪开始(模型报的是段内时间)。
 * 认不出格式的行接到上一行后面(模型偶尔把一句话折成两行);一行都认不出就整段当一个说话人。
 */
export function parseModelTranscript(text: string, offsetMs: number): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || /^```/.test(line)) continue
    const m = LINE.exec(line)
    if (m) {
      const body = m[5].trim()
      if (!body) continue
      out.push({ startMs: offsetMs + stampMs(m[1], m[2], m[3]), speaker: normalizeSpeaker(m[4]), text: body })
    } else if (out.length > 0) {
      out[out.length - 1].text += line
    } else {
      out.push({ startMs: offsetMs, speaker: '说话人 1', text: line })
    }
  }
  return out
}

/**
 * 模型在静音 / 噪音上会编字(recording-archive 的读数):一秒超过 25 个字、或同一句来回重复,就整段不要。
 */
export function looksHallucinated(lines: readonly TranscriptLine[], durationMs: number): boolean {
  const chars = lines.reduce((n, l) => n + l.text.length, 0)
  if (durationMs > 0 && chars / (durationMs / 1000) > 25) return true
  const counts = new Map<string, number>()
  for (const l of lines) {
    if (l.text.length < 6) continue
    const n = (counts.get(l.text) ?? 0) + 1
    counts.set(l.text, n)
    if (n >= 4) return true
  }
  return false
}

export function renderTranscript(lines: readonly TranscriptLine[]): string {
  return `${lines.map((l) => `[${formatTimestamp(l.startMs)}] ${l.speaker}：${l.text}`).join('\n')}\n`
}

export function parseTranscript(markdown: string): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const m = LINE.exec(raw.trim())
    if (m && m[5].trim()) out.push({ startMs: stampMs(m[1], m[2], m[3]), speaker: m[4].trim(), text: m[5].trim() })
  }
  return out
}

export function speakersOf(lines: readonly TranscriptLine[]): string[] {
  const seen: string[] = []
  for (const l of lines) if (!seen.includes(l.speaker)) seen.push(l.speaker)
  return seen
}

/** 接着上一段转写:把上一段最后几行带给模型,好让说话人编号接得上。 */
export function transcriptTail(lines: readonly TranscriptLine[], count = 6): string {
  return lines.slice(-count).map((l) => `${l.speaker}：${l.text}`).join('\n')
}

/** 交给听录音的模型的那句话。 */
export function transcriptionPrompt(previousTail: string): string {
  const base = [
    '逐字转写这段录音。按说话人分段,每段一行,格式:[mm:ss] 说话人N：内容。',
    'mm:ss 是这段录音里的时间;说话人从 1 开始按首次出现编号,同一个人始终用同一个编号。',
    '用录音里说的语言转写,不翻译、不总结、不加任何别的话。没有人声或只有噪音就什么都不输出。',
  ]
  if (previousTail.trim())
    base.push(`这是一段长录音的后续,上一段最后几句是(沿用其中的说话人编号):\n${previousTail.trim()}`)
  return base.join('\n')
}

// ── 总结 ─────────────────────────────────────────────────────────────────────

/** summary.md 第一行的标题;没有标题 = ''(调用方兜底「语音笔记」)。 */
export function summaryTitle(markdown: string): string {
  const first = markdown.replace(/\r\n/g, '\n').split('\n').find((line) => line.trim()) ?? ''
  const m = /^#\s+(.+)$/.exec(first.trim())
  return m ? m[1].trim().slice(0, 200) : ''
}

/** 正文里开头那个和标题一样的 `# 标题` 去掉(页头已经写着了)。 */
export function summaryBody(markdown: string): string {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  const lines = text.split('\n')
  if (lines.length && /^#\s+/.test(lines[0].trim())) return lines.slice(1).join('\n').trim()
  return text
}

// ── 导出(文件名 = 标题,`# 标题` + 总结 + `## 转写`) ────────────────────────────

export function exportFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120)
  return `${safe || '语音笔记'}.md`
}

export function exportMarkdown(input: { title: string; summary: string | null; lines: readonly TranscriptLine[] }): string {
  const parts = [`# ${input.title}`]
  const body = input.summary ? summaryBody(input.summary) : ''
  if (body) parts.push(body)
  if (input.lines.length) {
    parts.push('## 转写')
    parts.push(input.lines.map((l) => `${l.speaker} · ${formatTimestamp(l.startMs)}\n${l.text}`).join('\n\n'))
  }
  return `${parts.join('\n\n')}\n`
}

// ── 交给助理的话 ───────────────────────────────────────────────────────────────

/** 助理看得懂的「这一夹是什么」:第一次往云电脑上放语音笔记时写进去,之后它自己查得到。 */
export function voiceNotesReadme(): string {
  return [
    '# 语音笔记',
    '',
    '主人在咕咕里录的会议和语音。每条一个文件夹:',
    '',
    '- `note.json`:元数据与进度,由咕咕 App 维护,不要改。',
    '- `audio/`:录音,每 5 分钟一段。',
    '- `transcript.md`:转写,每行「[mm:ss] 说话人 N：内容」。',
    '- `summary.md`:你写的总结,第一行「# 标题」。',
    '',
    '咕咕把一条交给你时会告诉你是哪个文件夹。主人问起某次会议、某段录音时,也到这里来找。',
    '',
  ].join('\n')
}

function durationText(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`
}

/**
 * 转写好了之后交给个人助理的那一段(直接投进它自己那条会话,不进聊天记录)。
 * 「从主人的角度写」是我们的承诺(「从你的角度提炼总结」);写完在私聊里说一句 =「准备好后会通知你」。
 */
export function summaryRequestText(input: {
  dir: string
  ownerName: string | null
  createdAt: string
  durationMs: number
  speakers: number
  meetingTitle?: string | null
}): string {
  const owner = input.ownerName?.trim() || '主人'
  const at = new Date(input.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = Number.isNaN(at.getTime())
    ? input.createdAt
    : `${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`
  // 会议名来自日历(谁发来的邀请都能写):压成一行、截短、当引用的数据,❌ 让它读起来像这段话本身。
  const title = (input.meetingTitle ?? '').replace(/\s+/g, ' ').replace(/[「」]/g, '').trim().slice(0, 80)
  const meeting = title ? `,日历上这场会叫「${title}」` : ''
  return [
    `【咕咕 · 语音笔记】这是咕咕 App 自动交给你的活,不是${owner}在聊天里说的话。`,
    `${owner}在 ${when} 录了一段语音笔记(${durationText(input.durationMs)},${input.speakers} 位说话人${meeting})。转写已经写好:${input.dir}/${VOICE_NOTE_TRANSCRIPT_FILE}。`,
    '',
    '请你:',
    `1. 读转写,从${owner}的角度写一份总结,存成 ${input.dir}/${VOICE_NOTE_SUMMARY_FILE}。第一行「# 标题」(十来个字,说清是什么事),接着是要点:讨论了什么、定了什么、${owner}要做的事(单列待办)、要跟进的。用转写的语言写。认得出说话人是谁就写名字,认不出保留「说话人 N」。`,
    `2. 只写这一个文件,别的(note.json、录音、转写)不要动。`,
    `3. 写好后在你和${owner}的私聊里发一句:「语音笔记《标题》整理好了」,再加一句最要紧的事。别把整份总结贴进聊天。`,
    '4. 值得长期记住的(人、项目、约定),照你平时的习惯记进记忆。',
  ].join('\n')
}

/** 「就这次会议提问」:填进左边聊天框的开头,人接着打问题。 */
export function askAboutNoteDraft(title: string, dir: string): string {
  return `关于语音笔记《${title}》（${dir}）：`
}

// ── 会议提醒(会快开始时提醒你录音) ─────────────────────────────

export type UpcomingMeeting = { id: string; title: string; start: string; end: string | null; allDay: boolean }

/** 开会前多久弹(1 分钟)。 */
export const MEETING_REMIND_LEAD_MS = 60_000
/** 开始之后最多还挂多久(5 分钟,会先结束就到会结束为止)。 */
export const MEETING_REMIND_GRACE_MS = 5 * 60_000

/** 这一场在不在提醒的时间窗里(全天的不算会)。 */
export function meetingRemindable(meeting: UpcomingMeeting, now: number): boolean {
  if (meeting.allDay) return false
  const start = Date.parse(meeting.start)
  if (!Number.isFinite(start)) return false
  const end = meeting.end ? Date.parse(meeting.end) : NaN
  const until = Math.min(start + MEETING_REMIND_GRACE_MS, Number.isFinite(end) ? end : Infinity)
  return now >= start - MEETING_REMIND_LEAD_MS && now <= until
}

/** 该提醒哪一场:在时间窗里、这台电脑上还没提醒过的,开始得最早的那一场;同一场重复的只算一次(按 id + 开始时刻认)。 */
export function meetingToRemind(meetings: readonly UpcomingMeeting[], now: number, seen: ReadonlySet<string>): UpcomingMeeting | null {
  return (
    [...meetings]
      .filter((m) => meetingRemindable(m, now) && !seen.has(meetingKey(m)))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null
  )
}

export function meetingKey(meeting: Pick<UpcomingMeeting, 'id' | 'start'>): string {
  return `${meeting.id}@${meeting.start}`
}
