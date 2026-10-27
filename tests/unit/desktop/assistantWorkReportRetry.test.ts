import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { registerSessionpageTools } from '../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import { createDesktopWorkReportIds } from '../../../apps/desktop/electron/assistant-work-report-ids'
import { enqueueAssistantWorkReport } from '../../../packages/core/src/cloud/assistantWorkReports'

const workId = 'b316d3b6-6556-4231-a750-460c79dacb92'
const record = { to: ['session:home-session'], text: '需要你确认 X', work_result: { work_id: workId, status: 'question' } }
type Extra = { signal: AbortSignal; requestId: number | string; sessionId: string; _meta?: Record<string, unknown> }
type Handler = (args: unknown, extra: Extra) => Promise<{isError?: boolean; content: {text?: string}[]}>
const extra = (callId: string, requestId = 1, sessionId = 'connection-1'): Extra => ({
  signal: new AbortController().signal, requestId, sessionId, _meta: {'claudecode/toolUseId': callId},
})

function fixture() {
  const commits = new Map<string, Record<string, unknown>>()
  const events = new Map<string, Record<string, unknown>>()
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'assistant_work_history') return {data: {work: {work_id: workId, assistant_user_id: 'assistant', coordinator_session_id: 'home-session', coordinator_device_id: 'cloud', executors: [{session_id: 'child', device_id: 'mac'}]}, events: [...events.values()]}, error: null}
    commits.set(args.p_operation_id as string, args)
    for (const event of args.p_events as Record<string, unknown>[]) events.set(event.message_id as string, event)
    return {data: {work_id: workId, event_ids: (args.p_events as {message_id: string}[]).map(e => e.message_id), outcome: 'active', terminal_version: '0'}, error: null}
  })
  const prepare = vi.fn(async () => [{attachment_id: 'old-file', file_name: 'report.html', sha256: 'a'.repeat(64), size_bytes: 18, content_type: 'text/html'}])
  const registrar = () => {
    let handler!: Handler
    const server = {registerTool: (_name: unknown, _spec: unknown, run: Handler) => {handler = run}}
    registerSessionpageTools(server as never, [{name: 'report', action: 'message', description: 'Report task result.', schema: z.object({to: z.array(z.string()), text: z.string(), work_result: z.object({work_id: z.string(), status: z.string()}), files: z.array(z.object({file_path: z.string()})).optional()})}],
      action => enqueueAssistantWorkReport({rpc, prepare, resolveNumbers: async () => new Map(), id: createDesktopWorkReportIds('child')},
        {assistantId: 'assistant', runtimeInstanceId: 'runtime', sessionId: 'child', deviceId: 'mac', record: action as Record<string, unknown>}), () => '', async p => p)
    return handler
  }
  return {commits, events, rpc, prepare, registrar}
}

it('keeps one native call stable after a committed reply is lost and the host reconnects', async () => {
  const f = fixture(), handler = f.registrar()
  const commit = f.rpc.getMockImplementation()!
  f.rpc.mockImplementationOnce(async (name, args) => commit(name, args))
    .mockImplementationOnce(async (name, args) => {await commit(name, args); return {data: null, error: {code: 'NETWORK', message: 'reply lost'}} as never})
  expect((await handler(record, extra('call-1'))).isError).toBe(true)
  // A new registrar represents the restored host. Both transport and request IDs changed.
  expect((await f.registrar()(record, extra('call-1', 9, 'connection-2'))).isError).not.toBe(true)
  expect(f.commits.size).toBe(1)
  expect(f.events.size).toBe(1)
})

it('accepts an identical question from a later native tool invocation', async () => {
  const f = fixture(), handler = f.registrar()
  expect((await handler(record, extra('call-1'))).isError).not.toBe(true)
  expect((await handler(record, extra('call-2', 2))).isError).not.toBe(true)
  expect(f.commits.size).toBe(2)
  expect(f.events.size).toBe(2)
})

it('uploads the changed file for a new call with the same text and path; retry reuses that call’s file', async () => {
  const f = fixture(), handler = f.registrar()
  const report = {...record, files: [{file_path: '/report.html'}]}
  expect((await handler(report, extra('call-1'))).isError).not.toBe(true)
  f.prepare.mockResolvedValueOnce([{attachment_id: 'new-file', file_name: 'report.html', sha256: 'b'.repeat(64), size_bytes: 19, content_type: 'text/html'}])
  expect((await handler(report, extra('call-2', 2))).isError).not.toBe(true)
  expect((await f.registrar()(report, extra('call-2', 7, 'connection-2'))).isError).not.toBe(true)
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect([...f.events.values()].map(e => (e.attachment_refs as {sha256: string}[])[0]?.sha256)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  expect(f.commits.size).toBe(2)
})

it('rejects changed report bytes under the same call identity instead of creating a new report', async () => {
  const f = fixture(), handler = f.registrar()
  expect((await handler(record, extra('call-1'))).isError).not.toBe(true)
  const result = await handler({...record, text: 'changed'}, extra('call-1', 2))
  expect(result).toMatchObject({isError: true, content: [{text: 'error: WORK_REPORT_ID_CONFLICT'}]})
  expect(f.commits.size).toBe(1)
})

it('uses MCP connection and request IDs when the executor has no native call ID', async () => {
  const f = fixture(), handler = f.registrar()
  const request = (requestId: number, sessionId = 'codex-connection'): Extra => ({signal: new AbortController().signal, requestId, sessionId})
  await handler(record, request(12))
  await handler(record, request(12))
  expect(f.commits.size).toBe(1)
  await handler(record, request(13))
  expect(f.commits.size).toBe(2)
  // A restarted caller may repeat an old report. Never swallow a new call reusing that number.
  await handler(record, request(12, 'reconnected-codex'))
  expect(f.commits.size).toBe(3)
})
