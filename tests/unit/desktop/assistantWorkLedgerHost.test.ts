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
const commitCalls=()=>rpc.mock.calls.filter(([name])=>name==='assistant_work_commit')
const accepted=async(name:string,args:Record<string,unknown>)=> name==='assistant_work_coordinator_bind'?{data:{bound_count:0},error:null}:{data:{work_id:args.p_work_id,event_ids:(args.p_events as Array<{message_id:string}>).map(e=>e.message_id),outcome:'active',terminal_version:'0'},error:null}
beforeEach(async()=> { root=await mkdtemp(join(tmpdir(),'ledger-host-')); rpc.mockReset(); kick.mockReset();
  stop=installAssistantWorkLedgerHost({ context: async()=>({ client: { rpc },ownerId: owner,runtimeInstanceId: 'host-runtime',deviceId: 'home' }),kick }) })
afterEach(async()=> { stop?.(); await rm(root,{ recursive: true,force: true }) })
it('creates a dormant executor then atomically enqueues the sole first delivery and never reports it delivered',async()=> {
  rpc.mockImplementation(accepted)
  const run=vi.fn(async(raw: unknown)=> { const intent=(raw as {assistant_work: {child_session_id: string}}).assistant_work
    expect(rpc).not.toHaveBeenCalled()
    return { session_id: intent.child_session_id,assistant_work_target: { session_id: intent.child_session_id,device_id: 'worker-device' } } })
  const result=await coordinateAssistantAction({ sessionId: 'home-session',memoryDir: root,agentId: assistant },{ action: 'spawn',prompt: 'private instructions',title: 'Task' },run)
  expect(result).toMatchObject({ status: 'accepted' })
  expect(rpc.mock.calls.map(([name])=>name)).toEqual(['assistant_work_coordinator_bind','assistant_work_commit'])
  expect(rpc.mock.calls[0][1]).toMatchObject({p_assistant:assistant,p_runtime_instance_id:'host-runtime',p_session_id:'home-session'})
  expect(commitCalls()[0][1]).toMatchObject({ p_assistant: assistant,p_task: { title: 'Task',coordinator_session_id: 'home-session',executors: [{device_id: 'worker-device'}] },p_events: [{ kind: 'dispatch',from_device_id: 'home',to_device_id: 'worker-device',content: expect.stringContaining('private instructions') }] })
  expect(kick).toHaveBeenCalledOnce()
  expect(new AssistantWorkStore(root).list()[0]).toMatchObject({ state: 'waiting' })
  expect(await readFile(join(root,'pending-work.json'),'utf8')).not.toContain('private instructions')
})
it('freezes the addressed real session title across a lost receipt and later task rename',async()=>{
  const store=new AssistantWorkStore(root),id=store.begin({kind:'executor'})
  const intent=store.ledgerIntent(id,'call'),read=vi.fn(async()=> '复测回复「收到，测试正文」')
  expect(await store.dispatchTitle(id,intent.operation_id,read)).toBe('复测回复「收到，测试正文」')
  read.mockResolvedValue('Renamed after admission')
  expect(await new AssistantWorkStore(root).dispatchTitle(id,intent.operation_id,read)).toBe('复测回复「收到，测试正文」')
  expect(read).toHaveBeenCalledOnce()
})
it('reuses work, operation, message and executor ids after a committed cloud response was lost',async()=> {
  rpc.mockImplementation(async(name,args)=>name==='assistant_work_coordinator_bind'?accepted(name,args):{data:null,error:{code:'NETWORK',message:'response lost'}})
  const calls: unknown[]=[]
  const run=async(raw: unknown)=> { const intent=(raw as {assistant_work: {child_session_id: string}}).assistant_work; calls.push(intent)
    return { session_id: intent.child_session_id,assistant_work_target: { session_id: intent.child_session_id,device_id: 'worker' } } }
  const action={ action: 'spawn',prompt: 'request',title: 'Task' }
  const binding={ sessionId: 'home-session',memoryDir: root,agentId: assistant }
  await expect(coordinateAssistantAction(binding,action,run)).rejects.toThrow('response lost')
  await expect(coordinateAssistantAction(binding,action,run)).rejects.toThrow('response lost')
  expect(calls[1]).toEqual(calls[0])
  expect(commitCalls()[1][1]).toEqual(commitCalls()[0][1])
  expect(kick).not.toHaveBeenCalled()
})
it('atomically enqueues all addressed message targets and retains original native file metadata',async()=> {
  rpc.mockImplementation(accepted)
  const file={attachment_id:'10000000-0000-4000-8000-000000000006',file_name:'result.pdf',sha256:'a'.repeat(64),size_bytes:42,content_type:'application/pdf'}
  const run=async(raw: unknown)=> { const a=raw as { assistant_work: Parameters<typeof enqueueAssistantWorkMessage>[0];text: string }
    return enqueueAssistantWorkMessage(a.assistant_work,a.text,[file],[{sessionId:'first',deviceId:'worker'},{sessionId:'second',deviceId:'phone'}]) }
  const result=await coordinateAssistantAction({ sessionId:'home-session',memoryDir:root,agentId:assistant },{action:'message',to:['session:first','session:second'],text:'Please review'},run)
  expect(result).toMatchObject({ status:'accepted' })
  expect(commitCalls()[0][1].p_events).toHaveLength(2)
  expect(commitCalls()[0][1].p_events[0].attachment_refs).toEqual([file])
  expect(new Set(commitCalls()[0][1].p_events.map((e:{message_id:string})=>e.message_id)).size).toBe(2)
})
it('retains the recovery reference when the account runtime is not available before dispatch',async()=>{
  stop()
  await expect(coordinateAssistantAction({sessionId:'home-session',memoryDir:root,agentId:assistant},{action:'spawn',prompt:'request'},vi.fn())).rejects.toThrow('runtime is unavailable')
  expect(new AssistantWorkStore(root).list()).toHaveLength(1)
})

it('does not enqueue under an old account after the coordinator binding awaited an account switch',async()=>{
  const binding=Promise.withResolvers<{data:{bound_count:number};error:null}>()
  rpc.mockImplementation(async(name,args)=>name==='assistant_work_coordinator_bind'?binding.promise:accepted(name,args))
  const flight=coordinateAssistantAction({sessionId:'home-session',memoryDir:root,agentId:assistant},{action:'spawn',prompt:'request'},async(raw:unknown)=>{
    const intent=(raw as {assistant_work:{child_session_id:string}}).assistant_work
    return {session_id:intent.child_session_id,assistant_work_target:{session_id:intent.child_session_id,device_id:'worker'}}
  })
  await vi.waitFor(()=>expect(rpc).toHaveBeenCalledWith('assistant_work_coordinator_bind',expect.any(Object)))
  stop()
  const close=installAssistantWorkLedgerHost({context:async()=>({client:{rpc},ownerId:'another-owner',runtimeInstanceId:'another-runtime',deviceId:'home'}),kick})
  try {
    binding.resolve({data:{bound_count:0},error:null})
    await expect(flight).rejects.toThrow('runtime changed')
    expect(commitCalls()).toHaveLength(0)
  } finally {close()}
})

it('returns an accepted dispatch through the real tool registrar without double encoding session ids',async()=>{
  rpc.mockImplementation(accepted)
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

const workBlock=(text:string)=>JSON.parse(/<gugu_work>\n([^]*?)\n<\/gugu_work>/.exec(text)![1]!) as Record<string,unknown>
it('writes the dispatch kind and assistant into the executor block, never into the strict ledger intent',async()=>{
  rpc.mockImplementation(accepted)
  const sent:Array<{assistant_work:Parameters<typeof enqueueAssistantWorkMessage>[0];text:string;purpose?:unknown}>=[]
  const run=async(raw:unknown)=>{const a=raw as typeof sent[number];sent.push(a)
    return enqueueAssistantWorkMessage(a.assistant_work,a.text,[],[{sessionId:'executor',deviceId:'worker'}])}
  const binding={sessionId:'home-session',memoryDir:root,agentId:assistant}
  await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'问一句',purpose:'reply'},run)
  await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'做一件事',purpose:'task'},run)
  expect(sent.map(a=>workBlock(a.text))).toMatchObject([{assistant_id:assistant,purpose:'reply'},{assistant_id:assistant,purpose:'task'}])
  for(const a of sent){expect(a.assistant_work).not.toHaveProperty('purpose');expect(a).not.toHaveProperty('purpose')}
  expect(new AssistantWorkStore(root).list().map(row=>row.purpose)).toEqual(['reply','task'])
})
it('keeps the dispatched kind on follow-ups and never merges a relay with an assignment of the same turn',async()=>{
  rpc.mockImplementation(accepted)
  const texts:string[]=[]
  const run=async(raw:unknown)=>{const a=raw as {assistant_work:Parameters<typeof enqueueAssistantWorkMessage>[0];text:string};texts.push(a.text)
    return {...await enqueueAssistantWorkMessage(a.assistant_work,a.text,[],[{sessionId:'executor',deviceId:'worker'}]),
      recipients:[{to:'session:executor',session_id:'session:executor',status:'accepted' as const,message_id:`receipt-${texts.length}`}]}}
  const source='gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1/bfb72f98-986e-4314-b242-d9b95a0c8083'
  const binding={sessionId:'home-session',memoryDir:root,agentId:assistant}
  const task=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'做一件事',purpose:'task',source_link:source},run) as {work_id:string}
  // The executor asked a question; the assistant answers it as a reply on the same work.
  await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'答：用 A 方案',purpose:'reply',work_id:task.work_id},run)
  expect(workBlock(texts[1]!)).toMatchObject({work_id:task.work_id,purpose:'task'})
  const relay=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'顺便问一句',purpose:'reply',source_link:source},run) as {work_id:string}
  expect(relay.work_id).not.toBe(task.work_id)
  expect(workBlock(texts[2]!)).toMatchObject({work_id:relay.work_id,purpose:'reply'})
  const again=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'再补一个要求',purpose:'task',source_link:source},run) as {work_id:string}
  expect(again.work_id).toBe(task.work_id)
})
it('continues the executor\'s open work on a follow-up from a new chat message, and opens a new one only when asked (#615)',async()=>{
  rpc.mockImplementation(accepted)
  const sent:Array<{assistant_work:Parameters<typeof enqueueAssistantWorkMessage>[0];text:string;new_work?:unknown}>=[]
  const run=async(raw:unknown)=>{const a=raw as typeof sent[number];sent.push(a)
    return {...await enqueueAssistantWorkMessage(a.assistant_work,a.text,[],[{sessionId:'executor',deviceId:'worker'}]),
      recipients:[{to:'session:executor',session_id:'session:executor',status:'accepted' as const,message_id:`receipt-${sent.length}`}]}}
  const binding={sessionId:'home-session',memoryDir:root,agentId:assistant}
  const first='gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1/bfb72f98-986e-4314-b242-d9b95a0c8083'
  const second='gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1/0c1d7e0e-4a0e-4f43-9d55-7f5d1a0b2c3d'
  const task=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'看看 Mac 最近动态',purpose:'task',source_link:first},run) as {work_id:string}
  const followUp=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'再看看今天的',purpose:'task',source_link:second},run) as {work_id:string}
  expect(followUp.work_id).toBe(task.work_id)
  expect(sent.map(a=>a.assistant_work.continuation)).toEqual([false,true])
  expect(new AssistantWorkStore(root).list()).toHaveLength(1)
  const unrelated=await coordinateAssistantAction(binding,{action:'message',to:['session:executor'],text:'另外一件事',purpose:'new',source_link:second},run) as {work_id:string}
  expect(unrelated.work_id).not.toBe(task.work_id)
  expect(sent[2]!.assistant_work.continuation).toBe(false)
  expect(sent[2]).not.toHaveProperty('purpose')
  expect(workBlock(sent[2]!.text)).toMatchObject({purpose:'task'})
  expect(new AssistantWorkStore(root).list()).toHaveLength(2)
})
