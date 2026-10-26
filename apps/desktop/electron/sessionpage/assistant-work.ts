import { randomUUID,createHash } from 'node:crypto'
import { assistantWorkLedgerContext,enqueueAssistantWorkMessage } from './assistant-work-ledger'
import type { AssistantWorkIntent } from '@gugu/core/shared/assistantWorkIntent'
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
  try {
    const data = pendingAssistantWorkSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    let changed = false
    for (const row of data.items) {
      // Legacy unacknowledged work without any locator cannot be verified or safely redispatched.
      // Preserve it for the owner's recovery view, rather than silently expiring a possible commitment.
      if (row.kind === 'executor' && (row.state === 'uncertain' || row.state === 'blocked')
        && !row.source_link && !row.source_message_id && !row.source_summary && !row.recipients.length && !row.receipt_ids.length) {
        row.state = 'needs_source'; changed = true
      }
    }
    if (changed) atomic(path, data)
    return data
  }
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
  begin(input: Pick<PendingAssistantWork, 'kind' | 'device'> & WorkSource, targets: string[] = [], workId?: string,dispatchKey?: string): string {
    const data = read(this.path)
    const retry = dispatchKey && data.items.find(row => row.kind === 'executor' && row.dispatch_key === dispatchKey)
    if (retry && !workId) return retry.id
    const existing = data.items.find(row => row.kind === 'executor' && row.state === 'waiting'
      && targets.length > 0 && targets.every(target => row.recipients.includes(target))
      && (workId ? row.id === workId : input.source_link && row.source_link === input.source_link))
    if (workId && !existing) throw new Error('work_id does not identify waiting work for these executors; use the original full session: task address')
    if (existing) return existing.id
    const id = randomUUID()
    data.items.push({ ...input, id,...(dispatchKey ? {dispatch_key:dispatchKey} : {}), recipients: [], receipt_ids: [], state: 'dispatching', created_at: new Date().toISOString() })
    atomic(this.path, data)
    return id
  }
  ledgerIntent(id:string,key:string) {
    const data=read(this.path)
    const row=data.items.find(item=>item.id===id)
    if(!row) throw new Error('Assistant dispatch recovery reference is missing')
    const intents=row.ledger ??= {}
    if(intents[key]) return intents[key]
    const intent={operation_id:randomUUID(),message_id:randomUUID(),child_session_id:randomUUID()}
    intents[key]=intent
    atomic(this.path,data)
    return intent
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
  const binding = { sessionId,...(agentId ? { agentId } : {}), memoryDir: assistantHomePaths(homedir(), cwd, kind).memoryDir }
  new AssistantWorkStore(binding.memoryDir).list() // Normalize legacy recovery entries before startup hooks read them.
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

const EXECUTOR_REPORT = [
  'session_message to=[coordinator] text=summary work_result={work_id,status:progress|question|completed|cancelled}; verify result before completed; a failed delivery is progress, never completed.',
  'If Gugu messaging/upload/reporting fails, immediately report progress: work done or partial, failed step, observed cause category (permission/network/validation/unknown); if done say "做好了但交不回"; do not infer causes.',
  'If reporting also fails, preserve this notice in the task reply and stop; retain artifacts. Never read Gugu program directories or debug/repair the platform to resolve these tool failures.',
].join(' ')

/** Wrap only an explicitly identified assistant's dispatcher, before either local or remote routing. */
export async function coordinateAssistantAction(binding: AssistantWorkBinding, action: unknown,
  run: (action: unknown) => Promise<unknown>): Promise<unknown> {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return run(action)
  const record = action as Record<string, unknown>
  if (record.work_result || record.client_message_id) return run(action)
  const field = record.action === 'spawn' ? 'prompt' : record.action === 'message' ? 'text' : null
  if (!field) return run(action)
  const store = new AssistantWorkStore(binding.memoryDir)
  const source = await binding.currentInput?.()
  const dispatchKey = binding.agentId ? createHash('sha256').update(JSON.stringify([binding.sessionId,record,source])).digest('hex') : undefined
  const id = store.begin({ kind: 'executor',
    ...(typeof record.source_link === 'string' ? { source_link: record.source_link } : {}),
    ...source,
    ...(typeof record.device === 'string' ? { device: record.device } : {}) },
    Array.isArray(record.to) ? record.to.filter((value): value is string => typeof value === 'string') : [],
    typeof record.work_id === 'string' ? record.work_id : undefined,dispatchKey)
  let intent:AssistantWorkIntent | undefined
  if(binding.agentId) {
    const context=await assistantWorkLedgerContext().catch(error=>{store.uncertain(id);throw error})
    intent={version:1,assistant_id:binding.agentId,work_id:id,...store.ledgerIntent(id,dispatchKey!),
      coordinator:{session_id:binding.sessionId,device_id:context.deviceId},
      title:(typeof record.title==='string' && record.title.trim() ? record.title.trim() : '任务').slice(0,500),
      ...(typeof record.source_link==='string' ? {source_link:record.source_link} : {}),continuation:typeof record.work_id==='string'}
  }
  const dispatched = field ? { ...record,...(intent ? {assistant_work:intent} : {}), [field]: `${record[field]}\n\n<gugu_work>\n${JSON.stringify({ work_id: id,
    coordinator: `session:${binding.sessionId}`, report: EXECUTOR_REPORT })}\n</gugu_work>` } : action
  try {
    let result = await run(dispatched)
    if(intent && record.action==='spawn') {
      const target=(result as {assistant_work_target?:{session_id:string;device_id:string}})?.assistant_work_target
      if(!target || target.session_id!==intent.child_session_id) throw new Error('Executor host did not prepare an account work seat')
      const accepted=await enqueueAssistantWorkMessage(intent,(dispatched as Record<string,string>).prompt,[],[{sessionId:target.session_id,deviceId:target.device_id}])
      result={...(result as object),...accepted}
    }
    const out = result as { session_id?: string; recipients?: Array<{ to: string; session_id?: string; status: string; message_id?: string }>; state?: string; question_id?: string }
    if (record.action === 'spawn' && out?.session_id) store.confirm(id, [out.session_id.startsWith('session:') ? out.session_id : `session:${out.session_id}`], [])
    else if (record.action === 'message' && out?.recipients?.some(recipient => recipient.status === 'delivered' || recipient.status === 'accepted')) {
      const delivered = out.recipients.filter(recipient => recipient.status === 'delivered' || recipient.status === 'accepted')
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
