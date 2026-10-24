import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { assistantHomePaths, type AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { resolveGuguHome } from '@gugu/core/local/state/paths'

export { workReportSchema } from '../../src/session/shared/assistant-work'
import { pendingAssistantWorkSchema, workReportSchema, type WorkReport, type PendingAssistantWork } from '../../src/session/shared/assistant-work'
export type { WorkReport, PendingAssistantWork } from '../../src/session/shared/assistant-work'
type WorkSource = Pick<PendingAssistantWork, 'source_link' | 'source_message_id' | 'source_summary'>
export type AssistantWorkBinding = { sessionId: string; memoryDir: string; agentId?: string; currentInput?: () => Promise<WorkSource | undefined> }
const listeners = new Set<() => void>()
export function onAssistantWorkChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
const empty = () => ({ version: 1 as const, items: [] as PendingAssistantWork[] })

function read(path: string): ReturnType<typeof empty> {
  try { return pendingAssistantWorkSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error }
}
function atomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) { try { unlinkSync(temp) } catch { /* Preserve the original write failure. */ } throw error }
  if (path.endsWith('/pending-work.json') || path.endsWith('\\pending-work.json')) for (const listener of listeners) listener()
}

/** References, bounded original requirement excerpts and host receipts; never executor prompts or results. */
export class AssistantWorkStore {
  readonly path: string
  constructor(memoryDir: string) { this.path = join(memoryDir, 'pending-work.json') }
  list(): PendingAssistantWork[] { return read(this.path).items.filter(row => row.state !== 'dispatching') }
  begin(input: Pick<PendingAssistantWork, 'kind' | 'device'> & WorkSource, targets: string[] = [], workId?: string): string {
    const data = read(this.path)
    const existing = data.items.find(row => row.kind === 'executor' && row.state === 'waiting'
      && targets.length > 0 && targets.every(target => row.recipients.includes(target))
      && (workId ? row.id === workId : input.source_link && row.source_link === input.source_link))
    if (workId && !existing) throw new Error('work_id does not identify waiting work for these executors; use the original full session: task address')
    if (existing) return existing.id
    const id = randomUUID()
    data.items.push({ ...input, id, recipients: [], receipt_ids: [], state: 'dispatching', created_at: new Date().toISOString() })
    atomic(this.path, data)
    return id
  }
  confirm(id: string, recipients: string[], receipts: string[], questionId?: string): void {
    const data = read(this.path)
    const row = data.items.find(item => item.id === id)
    if (!row) return
    const completed = new Set(row.early?.filter(item => terminal(item.report)).map(item => item.sender) ?? [])
    row.recipients = [...new Set([...(row.state === 'waiting' ? row.recipients : []), ...recipients])].filter(recipient => !completed.has(recipient))
    row.receipt_ids = questionId ? [questionId] : [...new Set([...row.receipt_ids, ...receipts])]
    row.state = 'waiting'
    if (row.kind === 'executor' && recipients.length > 0 && row.recipients.length === 0) data.items = data.items.filter(item => item.id !== id)
    else delete row.early
    atomic(this.path, data)
  }
  uncertain(id: string): void {
    const data = read(this.path)
    const row = data.items.find(item => item.id === id)
    if (row) row.state = 'uncertain'
    atomic(this.path, data)
  }
  blocked(id: string): void {
    const data = read(this.path)
    const row = data.items.find(item => item.id === id)
    if (row) { row.state = 'blocked'; row.blocked_reason = 'device_no_task_runtime' }
    atomic(this.path, data)
  }
  remove(id: string): void {
    const data = read(this.path)
    data.items = data.items.filter(item => item.id !== id)
    atomic(this.path, data)
  }
  report(sender: string, report: WorkReport, receipt: string): void {
    const data = read(this.path)
    const row = data.items.find(item => item.id === report.work_id && item.kind === 'executor')
    if (!row) return
    if (row.state === 'dispatching') {
      row.early = [...(row.early ?? []), { sender, report, receipt }].slice(-16)
    } else if (row.recipients.includes(sender) && terminal(report)) {
      row.recipients = row.recipients.filter(recipient => recipient !== sender)
      if (!row.recipients.length) data.items = data.items.filter(item => item.id !== row.id)
    } else return
    atomic(this.path, data)
  }
  settleQuestion(questionId: string): void {
    const data = read(this.path)
    data.items = data.items.filter(row => row.kind !== 'question' || !row.receipt_ids.includes(questionId))
    atomic(this.path, data)
  }
  /** Forget the recovery entry, without sending anything or changing the executor. */
  clear(): void { atomic(this.path, empty()) }
}
const terminal = (report: WorkReport) => report.status === 'completed' || report.status === 'cancelled'
const registry = (sessionId: string) => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error('Invalid assistant session reference')
  return join(resolveGuguHome(), 'assistant-coordination', `${sessionId}.json`)
}
export function assistantWorkBinding(sessionId: string, cwd: string, kind: AssistantHomeKind, agentId?: string): AssistantWorkBinding {
  if (agentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error('Invalid assistant identity')
  const binding = { sessionId, memoryDir: assistantHomePaths(homedir(), cwd, kind).memoryDir }
  atomic(registry(sessionId), binding)
  if (agentId) atomic(join(resolveGuguHome(), 'assistant-coordination', 'by-agent', `${agentId}.json`), binding)
  return binding
}
function storeOf(sessionId: string): AssistantWorkStore | null {
  try {
    const binding = z.object({ sessionId: z.literal(sessionId), memoryDir: z.string().min(1) }).parse(JSON.parse(readFileSync(registry(sessionId), 'utf8')))
    return new AssistantWorkStore(binding.memoryDir)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function assistantWorkForAgent(agentId: string): AssistantWorkStore | null {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error('Invalid assistant identity')
  try {
    const binding = z.object({ memoryDir: z.string().min(1) }).parse(JSON.parse(readFileSync(join(resolveGuguHome(), 'assistant-coordination', 'by-agent', `${agentId}.json`), 'utf8')))
    return new AssistantWorkStore(binding.memoryDir)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function receiveAssistantWorkReport(sessionId: string, senderId: string, report: WorkReport, receipt: string): void {
  storeOf(sessionId)?.report(`session:${senderId}`, workReportSchema.parse(report), receipt)
}
export function settleAssistantQuestion(sessionId: string, questionId: string): void { storeOf(sessionId)?.settleQuestion(questionId) }
export function registerAssistantQuestion(sessionId: string, questionId: string, sourceLink?: string): void {
  const store = storeOf(sessionId)
  if (!store || store.list().some(row => row.receipt_ids.includes(questionId))) return
  const id = store.begin({ kind: 'question', ...(sourceLink ? { source_link: sourceLink } : {}) })
  store.confirm(id, [], [], questionId)
}

/** Wrap only an explicitly identified assistant's dispatcher, before either local or remote routing. */
export async function coordinateAssistantAction(binding: AssistantWorkBinding, action: unknown,
  run: (action: unknown) => Promise<unknown>): Promise<unknown> {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return run(action)
  const record = action as Record<string, unknown>
  if (record.work_result) return run(action)
  const field = record.action === 'spawn' ? 'prompt' : record.action === 'message' ? 'text' : null
  if (!field) return run(action)
  const store = new AssistantWorkStore(binding.memoryDir)
  const source = await binding.currentInput?.()
  const id = store.begin({ kind: 'executor',
    ...(typeof record.source_link === 'string' ? { source_link: record.source_link } : {}),
    ...source,
    ...(typeof record.device === 'string' ? { device: record.device } : {}) },
    Array.isArray(record.to) ? record.to.filter((value): value is string => typeof value === 'string') : [],
    typeof record.work_id === 'string' ? record.work_id : undefined)
  const dispatched = field ? { ...record, [field]: `${record[field]}\n\n<gugu_work>\n${JSON.stringify({ work_id: id,
    coordinator: `session:${binding.sessionId}`, report: 'session_message work_result={work_id,status:progress|question|completed|cancelled}; only report completed after verifying the requested result.' })}\n</gugu_work>` } : action
  try {
    const result = await run(dispatched)
    const out = result as { session_id?: string; recipients?: Array<{ to: string; session_id?: string; status: string; message_id?: string }>; state?: string; question_id?: string }
    if (record.action === 'spawn' && out?.session_id) store.confirm(id, [out.session_id.startsWith('session:') ? out.session_id : `session:${out.session_id}`], [])
    else if (record.action === 'message' && out?.recipients?.some(recipient => recipient.status === 'delivered')) {
      const delivered = out.recipients.filter(recipient => recipient.status === 'delivered')
      store.confirm(id, delivered.map(recipient => recipient.session_id ?? recipient.to), delivered.flatMap(recipient => recipient.message_id ? [recipient.message_id] : []))
    } else if (out?.state === 'pending' && out.question_id) store.confirm(id, [], [], out.question_id)
    else store.uncertain(id)
    return result && typeof result === 'object' ? { ...result, work_id: id } : result
  } catch (error) {
    // A failed RPC can have committed at the recipient. Preserve the gap without claiming successful dispatch.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'device_no_task_runtime') store.blocked(id)
    else store.uncertain(id)
    throw error
  }
}
