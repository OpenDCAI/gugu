import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { registerSessionpageTools } from '../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import { createDesktopWorkReportIds } from '../../../apps/desktop/electron/assistant-work-report-ids'
import { enqueueAssistantWorkReport } from '../../../packages/core/src/cloud/assistantWorkReports'

const workId = 'b316d3b6-6556-4231-a750-460c79dacb92'
const record = { to: ['session:home-session'], text: 'done', work_result: { work_id: workId, status: 'completed' } }
afterEach(() => vi.useRealTimers())

it('a report committed before the eight-second timeout is the same report on the next real registrar call', async () => {
  const commits = new Map<string, Record<string, unknown>>()
  let loseReply = true
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'assistant_work_history') return { data: { work: { work_id: workId, assistant_user_id: 'assistant', coordinator_session_id: 'home-session', coordinator_device_id: 'cloud', executors: [{session_id:'child',device_id:'mac'}] }, events: [] }, error: null }
    commits.set(args.p_operation_id as string, args)
    if (loseReply) { loseReply = false; return new Promise<never>(() => {}) }
    return {data:{work_id:workId,event_ids:(args.p_events as {message_id:string}[]).map(e=>e.message_id),outcome:'completed',terminal_version:'1'},error:null}
  })
  type Handler = (args: unknown, extra: {signal: AbortSignal}) => Promise<{isError?:boolean;content:{text?:string}[]}>
  let handler!: Handler
  const server = {registerTool:(_name:unknown,_spec:unknown,run:Handler)=>{handler=run}}
  registerSessionpageTools(server as never,[{name:'report',action:'message',description:'Report task result.',schema:z.object({to:z.array(z.string()),text:z.string(),work_result:z.object({work_id:z.string(),status:z.string()})})}],
    (action)=>enqueueAssistantWorkReport({rpc,prepare:async()=>[],resolveNumbers:async()=>new Map(),id:createDesktopWorkReportIds('child', action as Record<string,unknown>)},
      {assistantId:'assistant',runtimeInstanceId:'runtime',sessionId:'child',deviceId:'mac',record:action as Record<string,unknown>}),()=>'', async p=>p)
  const pending = handler(record,{signal:new AbortController().signal})
  expect((await pending).isError).toBe(true)
  expect((await handler(record,{signal:new AbortController().signal})).isError).not.toBe(true)
  expect(commits.size).toBe(1)
})

it('keys report identities by sender and immutable content, with separate message and operation IDs', () => {
  const first=createDesktopWorkReportIds('child',record)
  const message=first(),operation=first()
  expect(message).not.toBe(operation)
  const reordered={work_result:{status:'completed',work_id:workId},text:'done',to:['session:home-session']}
  const replay=createDesktopWorkReportIds('child',reordered)
  expect(replay()).toBe(message)
  expect(replay()).toBe(operation)
  expect(createDesktopWorkReportIds('another-child',record)()).not.toBe(message)
  expect(createDesktopWorkReportIds('child',{...record,text:'changed'})()).not.toBe(message)
  expect(createDesktopWorkReportIds('child',{...record,files:[{file_path:'/another-file'}]})()).not.toBe(message)
})
