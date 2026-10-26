import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {z} from 'zod'
import {registerSessionpageTools} from '../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { coordinateAssistantAction,AssistantWorkStore } from '../../../apps/desktop/electron/sessionpage/assistant-work'
import { installAssistantWorkLedgerHost,enqueueAssistantWorkMessage } from '../../../apps/desktop/electron/sessionpage/assistant-work-ledger'
const assistant='10000000-0000-4000-8000-000000000001'
const owner='10000000-0000-4000-8000-000000000002'
let root: string,stop: () => void
const rpc=vi.fn(),kick=vi.fn()
beforeEach(async()=> { root=await mkdtemp(join(tmpdir(),'ledger-host-')); rpc.mockReset(); kick.mockReset();
  stop=installAssistantWorkLedgerHost({ context: async()=>({ client: { rpc },ownerId: owner,runtimeInstanceId: 'host-runtime',deviceId: 'home' }),kick }) })
afterEach(async()=> { stop?.(); await rm(root,{ recursive: true,force: true }) })
it('creates a dormant executor then atomically enqueues the sole first delivery and never reports it delivered',async()=> {
  rpc.mockImplementation(async (_name,args)=>({ data: { work_id: args.p_work_id,event_ids: args.p_events.map((e: {message_id: string})=>e.message_id),outcome: 'active',terminal_version: '0' },error: null }))
  const run=vi.fn(async(raw: unknown)=> { const intent=(raw as {assistant_work: {child_session_id: string}}).assistant_work
    expect(rpc).not.toHaveBeenCalled()
    return { session_id: intent.child_session_id,assistant_work_target: { session_id: intent.child_session_id,device_id: 'worker-device' } } })
  const result=await coordinateAssistantAction({ sessionId: 'home-session',memoryDir: root,agentId: assistant },{ action: 'spawn',prompt: 'private instructions',title: 'Task' },run)
  expect(result).toMatchObject({ status: 'accepted' })
  expect(rpc).toHaveBeenCalledOnce()
  expect(rpc.mock.calls[0][0]).toBe('assistant_work_commit')
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_assistant: assistant,p_task: { title: 'Task',coordinator_session_id: 'home-session',executors: [{device_id: 'worker-device'}] },p_events: [{ kind: 'dispatch',from_device_id: 'home',to_device_id: 'worker-device',content: expect.stringContaining('private instructions') }] })
  expect(kick).toHaveBeenCalledOnce()
  expect(new AssistantWorkStore(root).list()[0]).toMatchObject({ state: 'waiting' })
  expect(await readFile(join(root,'pending-work.json'),'utf8')).not.toContain('private instructions')
})
it('reuses work, operation, message and executor ids after a committed cloud response was lost',async()=> {
  rpc.mockResolvedValue({ data: null,error: { code: 'NETWORK',message: 'response lost' } })
  const calls: unknown[]=[]
  const run=async(raw: unknown)=> { const intent=(raw as {assistant_work: {child_session_id: string}}).assistant_work; calls.push(intent)
    return { session_id: intent.child_session_id,assistant_work_target: { session_id: intent.child_session_id,device_id: 'worker' } } }
  const action={ action: 'spawn',prompt: 'request',title: 'Task' }
  const binding={ sessionId: 'home-session',memoryDir: root,agentId: assistant }
  await expect(coordinateAssistantAction(binding,action,run)).rejects.toThrow('response lost')
  await expect(coordinateAssistantAction(binding,action,run)).rejects.toThrow('response lost')
  expect(calls[1]).toEqual(calls[0])
  expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1])
  expect(kick).not.toHaveBeenCalled()
})
it('atomically enqueues all addressed message targets and retains original native file metadata',async()=> {
  rpc.mockImplementation(async (_n,a)=>({data:{work_id:a.p_work_id,event_ids:a.p_events.map((e:{message_id:string})=>e.message_id),outcome:'active',terminal_version:'0'},error:null}))
  const file={attachment_id:'10000000-0000-4000-8000-000000000006',file_name:'result.pdf',sha256:'a'.repeat(64),size_bytes:42,content_type:'application/pdf'}
  const run=async(raw: unknown)=> { const a=raw as { assistant_work: Parameters<typeof enqueueAssistantWorkMessage>[0];text: string }
    return enqueueAssistantWorkMessage(a.assistant_work,a.text,[file],[{sessionId:'first',deviceId:'worker'},{sessionId:'second',deviceId:'phone'}]) }
  const result=await coordinateAssistantAction({ sessionId:'home-session',memoryDir:root,agentId:assistant },{action:'message',to:['session:first','session:second'],text:'Please review'},run)
  expect(result).toMatchObject({ status:'accepted' })
  expect(rpc.mock.calls[0][1].p_events).toHaveLength(2)
  expect(rpc.mock.calls[0][1].p_events[0].attachment_refs).toEqual([file])
  expect(new Set(rpc.mock.calls[0][1].p_events.map((e:{message_id:string})=>e.message_id)).size).toBe(2)
})
it('retains the recovery reference when the account runtime is not available before dispatch',async()=>{
  stop()
  await expect(coordinateAssistantAction({sessionId:'home-session',memoryDir:root,agentId:assistant},{action:'spawn',prompt:'request'},vi.fn())).rejects.toThrow('runtime is unavailable')
  expect(new AssistantWorkStore(root).list()).toHaveLength(1)
})

it('returns an accepted dispatch through the real tool registrar without double encoding session ids',async()=>{
  rpc.mockImplementation(async(_n,a)=>({data:{work_id:a.p_work_id,event_ids:a.p_events.map((e:{message_id:string})=>e.message_id),outcome:'active',terminal_version:'0'},error:null}))
  let call:(args:unknown,extra:{signal:AbortSignal})=>Promise<{isError?:boolean;content:unknown[]}>=undefined!
  registerSessionpageTools({registerTool:(_name:unknown,_options:unknown,handler:typeof call)=>{call=handler}} as never,
    [{name:'session_message',action:'message',description:'send',schema:z.object({to:z.array(z.string()),text:z.string()})}],
    action=>coordinateAssistantAction({sessionId:'home-session',memoryDir:root,agentId:assistant},action,raw=>{
      const a=raw as {assistant_work:Parameters<typeof enqueueAssistantWorkMessage>[0];text:string}
      return enqueueAssistantWorkMessage(a.assistant_work,a.text,[],[{sessionId:'executor',deviceId:'worker'}])
    }),()=>'Unavailable',async work=>work)
  const answer=await call({to:['session:executor'],text:'Task'},{signal:new AbortController().signal})
  expect(answer.isError).not.toBe(true)
  expect(JSON.stringify(answer.content)).toContain('accepted')
})
