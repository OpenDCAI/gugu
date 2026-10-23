import {
  asRecord,
  cleanText,
  clipTitle,
  entryTimestamp,
  nonEmptyString,
  type JsonlTranscriptSourceSpec,
  type TranscriptFrame
} from '../transcriptSource'
import { isDeliveryEnvelope } from '../deliveryEnvelope'

// Claude Code 的本机会话：`~/.claude/projects/<项目目录>/<sessionId>.jsonl`。
// 逐行 JSON，每行自带 sessionId / cwd / timestamp。
//
// 「记录里的一行是什么意思」只有 `readClaudeRecord` 这一份：导入清单（下面的 readFrame）与会话页时间线
// （session-core 的 claude-jsonl 记录源）都从它取，各自只做自己那一层映射。

/** Claude's recorded file result; no file contents are reconstructed from tool arguments. */
export type ClaudeFileChange =
  | { path: string; before: string | null; after: string }
  | { path: string; hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }> }

export type ClaudeRecordItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: unknown; fileChange?: ClaudeFileChange }

/** 这一行把这一轮收在哪。`aborted` = 用户按 Esc / 宿主发 cancel 打断;`error` = claude 自己记下的 API 报错(额度、4xx/5xx)。 */
export type ClaudeRecordEnd = 'end_turn' | 'max_tokens' | 'refusal' | 'error' | 'aborted'

export interface ClaudeRecord {
  /** 子 agent 旁支：它有自己的记录文件，不是用户那条会话。旁支行其余字段一律不读。 */
  sidechain: boolean
  providerSessionId?: string
  cwd?: string
  title?: { text: string; userSet: boolean }
  timestamp: string | null
  uuid: string | null
  /**
   * 这一行属于哪条消息。assistant 行是 API 的消息 id（一条消息跨好几行）；用户位上一行就是一条消息，
   * 用这一行的 uuid —— 连着的两条输入没有各自的 id，就会被接成一条。
   */
  messageId: string | null
  items: ClaudeRecordItem[]
  end: ClaudeRecordEnd | null
}

/**
 * 「是不是用户说的话」的唯一判据，按块判。
 *
 * Claude 把**斜杠命令回显 / 本地命令输出 / 系统注入 / 压缩后的摘要**也记在用户位上
 * （`<command-name>…`、`<local-command-stdout>…`、`<task-notification>…`、`Caveat:…`、`isMeta`、`isCompactSummary`）。
 * 这些不是用户说的话：不上时间线、不当标题，也绝不能进上云摘录 —— 本地命令输出可能含密钥 regex
 * 覆盖不到的隐私内容。
 */
function isUserText(text: string, isMeta: boolean): boolean {
  const trimmed = text.trim()
  if (isMeta || trimmed.length === 0) return false
  if (trimmed.startsWith('<')) return isDeliveryEnvelope(trimmed)
  return !trimmed.startsWith('Caveat:')
}

/**
 * 用户按 Esc / 宿主发协议 cancel 打断一轮时,claude 往记录里写的**不是** assistant 的
 * `stop_reason`(那条 assistant 记录的 stop_reason 是 null),而是一条 `type: 'user'`、正文只有
 * 这句话的记录(工具中途被打断时是 `…interrupted by user for tool use]`)。
 * 它不是用户说的话,是这一轮的**收尾** —— 当成新一轮用户消息,手机页头会永远显示「在跑」。
 */
const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/

function isInterruptMarker(content: unknown): boolean {
  if (typeof content === 'string') return INTERRUPT_MARKER.test(content.trim())
  if (!Array.isArray(content) || content.length !== 1) return false
  const block = asRecord(content[0])
  return block?.type === 'text' && typeof block.text === 'string' && INTERRUPT_MARKER.test(block.text.trim())
}

/**
 * claude 的 `stop_reason`。取值以 Anthropic Messages API 的枚举为准：
 * `tool_use` / `pause_turn` 是「接着干」（当成收尾会把一轮切成好几轮），其余都是这一轮到此为止。
 */
function readStopReason(value: unknown): ClaudeRecordEnd | null {
  if (typeof value !== 'string' || value === 'tool_use' || value === 'pause_turn') return null
  return value === 'max_tokens' || value === 'refusal' ? value : 'end_turn'
}

/**
 * agent 忙时到的输入（咕咕投递、人在忙时打的字）claude 不写 user 行，只写一行
 * `{"type":"attachment","attachment":{"type":"queued_command","commandMode":"prompt","prompt":…}}`；
 * 空闲时到的才是普通 user 行，两者互斥。`isMeta` 在 attachment 里。
 * 别的 commandMode（`task-notification`）与缺 commandMode 的（带 isMeta 的 `<agent-message>`）都不是输入。
 */
function queuedPrompt(entry: Record<string, unknown>): { content: unknown; isMeta: boolean } | null {
  const attachment = entry.type === 'attachment' ? asRecord(entry.attachment) : null
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null
  return { content: attachment.prompt, isMeta: attachment.isMeta === true }
}

function readItems(content: unknown, role: 'user' | 'assistant', isMeta: boolean): ClaudeRecordItem[] {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const items: ClaudeRecordItem[] = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    const item = block ? readBlock(block, role, isMeta) : null
    if (item) items.push(item)
  }
  return items
}

function readBlock(block: Record<string, unknown>, role: 'user' | 'assistant', isMeta: boolean): ClaudeRecordItem | null {
  switch (block.type) {
    case 'text': {
      const text = typeof block.text === 'string' ? block.text : ''
      // assistant 不过判据：那几个前缀是「用户位」上的机器记录才有的特征。
      const keep = role === 'user' ? isUserText(text, isMeta) : text.trim().length > 0
      return keep ? { kind: 'text', role, text } : null
    }
    case 'thinking':
      return typeof block.thinking === 'string' && block.thinking.length > 0
        ? { kind: 'thinking', text: block.thinking }
        : null
    case 'tool_use': {
      const id = nonEmptyString(block.id)
      const name = nonEmptyString(block.name)
      return id && name ? { kind: 'tool_use', id, name, input: block.input } : null
    }
    case 'tool_result': {
      const toolUseId = nonEmptyString(block.tool_use_id)
      return toolUseId ? { kind: 'tool_result', toolUseId, isError: block.is_error === true, content: block.content } : null
    }
    default:
      return null
  }
}

/**
 * claude 写**两种**标题记录，只认一种会让绝大多数会话的标题静默丢失：
 *   {"type":"custom-title","customTitle":…}  用户手改的
 *   {"type":"ai-title",    "aiTitle":…}      引擎自己拟的
 * d15 上 600 份真实会话实测：287 份带标题记录，其中 274 份**只有** ai-title。
 *
 * ⚠️ 两者同时存在时（实测 8 份）以 **custom-title 为准**：那是用户亲手写的，不能被引擎后拟的标题盖掉，
 * 而两种记录的先后不保证 —— 所以要带上 `userSet`，不能靠出现顺序。
 *
 * ⚠️ 走 `cleanText` 而不是只判非空串：全是空白的标题是「没有标题」，不是「标题是空的」。
 * ⚠️ 必须先判 `typeof === 'string'`,❌ 别用 `String(x ?? '')` 兜:载荷是对象时会变成
 * `'[object Object]'`,那是一个看着像标题的标题。不认识的形状该忽略,不该强转。
 */
function readTitle(entry: Record<string, unknown>): ClaudeRecord['title'] {
  const userSet = entry.type === 'custom-title'
  const raw = userSet ? entry.customTitle : entry.type === 'ai-title' ? entry.aiTitle : null
  const text = typeof raw === 'string' ? cleanText(raw) : null
  return text ? { text, userSet } : undefined
}

function recordedFileChange(value: unknown): ClaudeFileChange | undefined {
  const result = asRecord(value)
  const path = nonEmptyString(result?.filePath)
  if (!result || !path) return undefined
  if ((result.type === 'create' || result.type === 'update') && typeof result.content === 'string'
    && (result.originalFile === null || typeof result.originalFile === 'string')) {
    return { path, before: result.originalFile, after: result.content }
  }
  if (!Array.isArray(result.structuredPatch)) return undefined
  const hunks: Extract<ClaudeFileChange, { hunks: unknown }>['hunks'] = []
  for (const value of result.structuredPatch) {
    const hunk = asRecord(value)
    if (!hunk || !['oldStart', 'oldLines', 'newStart', 'newLines'].every(key => Number.isInteger(hunk[key]) && Number(hunk[key]) >= 0)
      || !Array.isArray(hunk.lines) || !hunk.lines.every(line => typeof line === 'string')) return undefined
    hunks.push({ oldStart: Number(hunk.oldStart), oldLines: Number(hunk.oldLines), newStart: Number(hunk.newStart), newLines: Number(hunk.newLines), lines: hunk.lines })
  }
  return { path, hunks }
}

export function readClaudeRecord(entry: Record<string, unknown>): ClaudeRecord {
  const uuid = nonEmptyString(entry.uuid) ?? null
  const record: ClaudeRecord = {
    sidechain: entry.isSidechain === true,
    timestamp: entryTimestamp(entry),
    uuid,
    messageId: null,
    items: [],
    end: null
  }
  if (record.sidechain) return record
  record.providerSessionId = nonEmptyString(entry.sessionId)
  record.cwd = nonEmptyString(entry.cwd)
  record.title = readTitle(entry)

  const queued = queuedPrompt(entry)
  if (queued) {
    record.messageId = uuid
    record.items = readItems(queued.content, 'user', queued.isMeta)
    return record
  }
  const message = entry.type === 'user' || entry.type === 'assistant' ? asRecord(entry.message) : null
  if (!message) return record
  if (entry.type === 'assistant') {
    record.messageId = nonEmptyString(message.id) ?? null
    record.items = readItems(message.content, 'assistant', false)
    record.end = readStopReason(message.stop_reason)
    // 被拒那一行也带 isApiErrorMessage:先认 refusal,其余带它的才是报错(claude 合成那一行,stop_reason 是 stop_sequence)。
    if (record.end !== 'refusal' && entry.isApiErrorMessage === true) record.end = 'error'
  } else if (isInterruptMarker(message.content)) {
    record.end = 'aborted'
  } else {
    record.messageId = uuid
    // 压缩后的摘要（"This session is being continued…"）是写给模型的续写上下文，终端腿和 ACP 腿都这样记。
    record.items = readItems(message.content, 'user', entry.isMeta === true || entry.isCompactSummary === true)
  }
  // The top-level result belongs to one tool result. Multiple result blocks provide no unambiguous owner.
  const results = record.items.filter((item): item is Extract<ClaudeRecordItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
  if (results.length === 1 && !results[0]!.isError) {
    const fileChange = recordedFileChange(entry.toolUseResult)
    if (fileChange) results[0]!.fileChange = fileChange
  }
  return record
}

export const claudeCodeTranscriptSource: JsonlTranscriptSourceSpec = {
  channel: 'jsonl',
  id: 'claude-code',
  fileExtension: '.jsonl',

  recordsDir: 'projects',

  readFrame(entry): TranscriptFrame | null {
    const record = readClaudeRecord(entry)
    // 子 agent 旁支 transcript —— 整份文件不是用户会话。
    if (record.sidechain) return { sidechain: true }
    const frame: TranscriptFrame = { providerSessionId: record.providerSessionId, cwd: record.cwd }
    if (record.title) {
      frame.explicitTitle = clipTitle(record.title.text)
      if (record.title.userSet) frame.explicitTitleIsUserSet = true
    }
    // 摘录只要对话正文：工具调用/结果/思考一律不算。
    const texts = record.items.flatMap((item) => (item.kind === 'text' ? [item] : []))
    const content = cleanText(texts.map((item) => item.text).join('\n'))
    if (content) frame.turn = { role: texts[0].role, content, createdAt: record.timestamp }
    return frame
  }
}
