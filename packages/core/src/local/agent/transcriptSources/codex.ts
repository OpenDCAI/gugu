import { codexReasoningText } from '../../../shared/reasoningText.mjs'
import {
  asRecord,
  cleanText,
  entryTimestamp,
  nonEmptyString,
  type JsonlTranscriptSourceSpec,
  type TranscriptFrame
} from '../transcriptSource'
import { isDeliveryEnvelope } from '../deliveryEnvelope'
import { contextText, contextToolRefs, type ContextFrame } from './contextProjection'

function codexContext(entry: Record<string, unknown>, record: CodexRecord): ContextFrame {
  const payload = asRecord(entry.payload)
  const loaded: NonNullable<ContextFrame['loaded']> = []
  if (entry.type === 'session_meta') {
    const text = contextText(payload?.base_instructions)
    if (text !== null) loaded.push({ path: null, kind: 'base-instructions', scope: 'Global', chars: text.length, truncated: false, at: record.timestamp })
  }
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    const object = asRecord(value)
    if (!object) return
    const agents = asRecord(object.agents_md)
    if (agents && typeof agents.directory === 'string') {
      const text = contextText(agents.text)
      if (text !== null) loaded.push({ path: `${agents.directory.replace(/[\\/]$/, '')}/AGENTS.md`, kind: 'instruction-file', scope: 'Project', chars: text.length, truncated: false, at: record.timestamp })
    }
    Object.values(object).forEach(visit)
  }
  // Inspect only world_state metadata, never the tool outputs or reasoning records that share this file.
  if (entry.type === 'world_state' || payload?.type === 'world_state') visit(payload ?? entry.world_state)
  else if (payload?.world_state !== undefined) visit(payload.world_state)
  else if (entry.world_state !== undefined) visit(entry.world_state)
  return { loaded, refs: record.item?.kind === 'tool_call' ? contextToolRefs(record.item.name, record.item.input) : [] }
}

// Codex 的本机会话：`~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<sessionId>.jsonl`。
// 与 claude 的两处结构差异：
//  ① 元信息只在**一条** `session_meta` 记录里（实测 d15 上 24 份 rollout，每份恰好一条），
//     不像 claude 每行都带；
//  ② 对话在 `response_item` 的 `payload` 里，用 `input_text` / `output_text` 分收发。
//
// 「记录里的一行是什么意思」只有 `readCodexRecord` 这一份：导入清单（下面的 readFrame）与会话页时间线
// （session-core 的 codex-jsonl 记录源）都从它取，各自只做自己那一层映射。

export type CodexRecordItem =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown; namespace?: string }
  | { kind: 'tool_result'; callId: string; output: unknown; failed: boolean }
  | { kind: 'subagent'; id: string; threadId: string; name: string; activity: string }

/** 这一行把这一轮收在哪。`aborted` = 用户打断。 */
export type CodexRecordEnd = 'end_turn' | 'failed' | 'aborted'

export interface CodexRecord {
  /** `session_meta` 那一行带的会话元信息。 */
  meta?: { providerSessionId?: string; cwd?: string; sidechain: boolean }
  timestamp: string | null
  /** 新的一轮从这一行开始。 */
  turnStart: boolean
  item: CodexRecordItem | null
  end: CodexRecordEnd | null
}

/**
 * Codex 的注入块不是对话内容：与 claude 同口径，非投递 envelope 的 `'<'` 开头 user 文本视为机器注入
 * （`<environment_context>` / `<permissions…>` / `<user_instructions>` / `<turn_context>` /
 * `<agent_identity>` / `<INSTRUCTIONS>` 等；实测清单里还会漂出 ACP 注入的 `<agent_identity>`），
 * 另加 AGENTS.md 正文前缀。
 */
const INJECTED_USER_PREFIXES = ['# AGENTS.md instructions']

/** 「是不是用户说的话」的唯一判据。 */
function isUserText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('<')) return isDeliveryEnvelope(trimmed)
  return !INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function isCodexSubagent(payload: Record<string, unknown>): boolean {
  const source = asRecord(payload.source)
  const subagent = asRecord(source?.subagent)
  const threadSpawn = asRecord(subagent?.thread_spawn)
  return Boolean(
    nonEmptyString(payload.parent_thread_id)
    ?? nonEmptyString(payload.parentThreadId)
    ?? nonEmptyString(threadSpawn?.parent_thread_id)
    ?? nonEmptyString(threadSpawn?.parentThreadId),
  )
}

/** 一组块里的文字（消息正文、思考摘要、思考原文都是 `[{type, text}]`）。 */
function blockTexts(blocks: unknown): string[] {
  if (typeof blocks === 'string') return [blocks]
  if (!Array.isArray(blocks)) return []
  return blocks.flatMap((block) => {
    const text = asRecord(block)?.text
    return typeof text === 'string' && text.length > 0 ? [text] : []
  })
}

/**
 * 判失败只认 codex **自己写下来的**结论，❌ 不去猜 stderr 有没有内容。
 * 拿不准就报 completed：把成功的调用染红比漏掉一次失败更难查（红了以后没人再信这个标记）。
 */
function failedFromOutput(payload: Record<string, unknown>): boolean {
  if (payload.success === false) return true
  const structured = asRecord(payload.output)
  if (structured?.success === false) return true
  const metadata = asRecord(structured?.metadata)
  if (typeof metadata?.exit_code === 'number' && metadata.exit_code !== 0) return true
  if (typeof payload.output === 'string') {
    const match = /^Exit code:\s*(\d+)/m.exec(payload.output)
    if (match && match[1] !== '0') return true
  }
  return false
}

function readResponseItem(payload: Record<string, unknown>): CodexRecordItem | null {
  switch (payload.type) {
    case 'message': {
      const role = payload.role
      if (role !== 'user' && role !== 'assistant') return null // developer/system 位是注入的运行时上下文
      const text = blockTexts(payload.content).join('\n')
      if (text.trim().length === 0) return null
      return role === 'assistant' || isUserText(text) ? { kind: 'text', role, text } : null
    }
    case 'reasoning': {
      // 摘要是 `summary_text` 块，原文是 `reasoning_text` 块；`encrypted_content` 不进任何一组。
      const text = codexReasoningText(blockTexts(payload.summary), blockTexts(payload.content))
      return text ? { kind: 'thinking', text } : null
    }
    case 'function_call':
    case 'custom_tool_call': {
      const id = nonEmptyString(payload.call_id)
      const bare = nonEmptyString(payload.name)
      // An MCP tool is recorded as `namespace: "mcp__<server>"` + its bare name; `mcp__<server>__<tool>` is the title shape the reducer reads as MCP.
      const namespace = nonEmptyString(payload.namespace)
      const name = bare && namespace?.startsWith('mcp__') ? `${namespace}__${bare}` : bare
      return id && name ? { kind: 'tool_call', id, name, input: payload.arguments ?? payload.input, ...(namespace === 'collaboration' ? { namespace } : {}) } : null
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = nonEmptyString(payload.call_id)
      return callId ? { kind: 'tool_result', callId, output: payload.output, failed: failedFromOutput(payload) } : null
    }
    default:
      return null
  }
}

/**
 * codex 把同一句话记两遍：`response_item`（喂给模型的历史）和 `event_msg`（给 TUI 看的事件）。
 * 本机 40 份 rollout 实测：`response_item/message` role=assistant 与 `event_msg/agent_message`
 * 都是 242 条，一一对应。两条都收就是每句话说两遍，所以内容**只认 response_item 这一路**，
 * event_msg 里只取 response_item 表达不了的东西：回合起止（本机一份 54MB 真 rollout 实测
 * `task_started` 18 次 / `task_complete` 17 次 / `turn_aborted` 1 次，数得上）。
 */
export function readCodexRecord(entry: Record<string, unknown>): CodexRecord {
  const payload = asRecord(entry.payload)
  const event = entry.type === 'event_msg' ? payload?.type : undefined
  const record: CodexRecord = {
    timestamp: entryTimestamp(entry),
    turnStart: event === 'task_started',
    item: entry.type === 'response_item' && payload ? readResponseItem(payload) : null,
    // 失败的一轮也记成 `task_complete`,区别是带着 `error`:codex 自己就按这一格判 Failed
    // (app-server-protocol `thread_history_projection.rs` 对 TurnComplete 的投影)。
    end:
      event === 'task_complete'
        ? payload?.error == null ? 'end_turn' : 'failed'
        : event === 'turn_aborted' ? 'aborted' : null
  }
  if (event === 'item_completed') {
    const item = asRecord(payload?.item)
    if (item?.type === 'SubAgentActivity' && typeof item.agent_thread_id === 'string' && typeof item.agent_path === 'string' && typeof item.id === 'string') {
      record.item = { kind: 'subagent', id: item.id, threadId: item.agent_thread_id, name: item.agent_path, activity: String(item.kind) }
    }
  }
  if (entry.type === 'session_meta' && payload) {
    record.meta = { providerSessionId: nonEmptyString(payload.id), cwd: nonEmptyString(payload.cwd), sidechain: isCodexSubagent(payload) }
  }
  return record
}

export const codexTranscriptSource: JsonlTranscriptSourceSpec = {
  channel: 'jsonl',
  id: 'codex',
  fileExtension: '.jsonl',

  recordsDir: 'sessions',

  readFrame(entry, view): TranscriptFrame | null {
    const record = readCodexRecord(entry)
    const context = view === 'context' ? { context: codexContext(entry, record) } : {}
    if (record.meta) {
      const { providerSessionId, cwd, sidechain } = record.meta
      return { providerSessionId, cwd, ...context, ...(sidechain ? { sidechain: true } : {}) }
    }
    // 摘录只要对话正文：工具调用/结果/思考一律不算。
    if (record.item?.kind !== 'text') return view === 'context' ? context : null
    const content = cleanText(record.item.text)
    return content ? { ...context, turn: { role: record.item.role, content, createdAt: record.timestamp } } : view === 'context' ? context : null
  }
}
