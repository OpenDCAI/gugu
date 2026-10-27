import {expect,it,vi} from 'vitest'
import {buildSessionDirectEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {createDesktopAssistantWorkHistory} from '../../../apps/desktop/electron/assistant-work-history'
const assistant='10000000-0000-4000-8000-000000000001',executor='10000000-0000-4000-8000-000000000002',coordinator='10000000-0000-4000-8000-000000000003',child='10000000-0000-4000-8000-000000000004',workId='10000000-0000-4000-8000-000000000005'
const dispatch='10000000-0000-4000-8000-000000000006',result='10000000-0000-4000-8000-000000000007'
const envelope=(id:string,sender:string,content:string)=>buildSessionDirectEnvelope({senderSessionId:sender,senderTitle:'Agent',messageId:id,content,at:'2026-10-20T08:00:00Z'})
it('uploads only original locally accepted receipts without live providers or a second delivery',async()=>{
 const work={work_id:workId,assistant_user_id:assistant,title:'Old work',coordinator_session_id:coordinator,coordinator_device_id:'desktop',executors:[{session_id:child,device_id:'desktop',agent_user_id:executor}]}
 let stored=false
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>name==='assistant_work_history' ? {data:stored?{work,events:[],next_after:null}:null,error:stored?null:{code:'42501',message:'Work is not available to this account'}} : (stored=true,{data:{event_ids:(args.p_events as {message_id:string}[]).map(e=>e.message_id)},error:null}))
 const entries=[{id:dispatch,position:1,sessionId:child,title:'Old work',timestamp:'2026-10-20 08:00:00',spawnedBySessionId:coordinator,spawnedByRemote:null,
  content:envelope(dispatch,coordinator,`Old request\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`)},
  {id:result,position:2,sessionId:coordinator,title:'Assistant',timestamp:'2026-10-20 08:02:00',spawnedBySessionId:null,spawnedByRemote:null,
  content:envelope(result,child,`A verified result\n<gugu_work_result>\n${JSON.stringify({work_id:workId,status:'completed'})}\n</gugu_work_result>`)}]
 const host=createDesktopAssistantWorkHistory({context:async()=>({ownerId:'owner',deviceId:'desktop',runtimeInstanceId:'runtime',client:{rpc}}),
  receipts:async()=>({entries,cursor:2,hasMore:false}),identity:async(session:string)=>({id:session===child?executor:assistant,createdAt:Date.parse('2026-10-19T08:00:00Z')}),
  assistant:async()=>assistant,warn:vi.fn()})
 await host.kick();await host.kick();host.stop()
 const imports=rpc.mock.calls.filter(([name])=>name==='assistant_work_import')
 expect(imports).toHaveLength(2)
 expect(imports[0]![1]).toMatchObject({p_work_id:workId,p_events:[{message_id:dispatch,kind:'dispatch',receipt_kind:'received'}]})
 expect(imports[1]![1]).toMatchObject({p_events:[{message_id:result,kind:'completed',occurred_at:'2026-10-20T08:02:00.000Z',receipt_kind:'received'}]})
 expect(rpc.mock.calls.some(([name])=>name.includes('outbox')||name==='assistant_work_commit')).toBe(false)
})

it('does not copy old inbox contents into a later account identity bound to the same session',async()=>{
 const rpc=vi.fn()
 const host=createDesktopAssistantWorkHistory({context:async()=>({ownerId:'later-owner',deviceId:'desktop',runtimeInstanceId:'runtime',client:{rpc}}),
  receipts:async()=>({entries:[{id:dispatch,position:1,sessionId:child,title:'Old work',timestamp:'2026-10-20T08:00:00Z',spawnedBySessionId:coordinator,spawnedByRemote:null,
    content:envelope(dispatch,coordinator,`Private original request\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`)}],cursor:1,hasMore:false}),
  identity:async()=>({id:executor,createdAt:Date.parse('2026-10-21T08:00:00Z')}),assistant:async()=>assistant,warn:vi.fn()})
 await host.kick();host.stop()
 expect(rpc).not.toHaveBeenCalled()
})

it('keeps an already uploaded message authoritative even if native delivery decorated the local body',async()=>{
 const work={work_id:workId,assistant_user_id:assistant,title:'Work',coordinator_session_id:coordinator,coordinator_device_id:'desktop',executors:[{session_id:child,device_id:'desktop',agent_user_id:executor}]}
 const rpc=vi.fn(async(name:string)=>name==='assistant_work_history'?{data:{work,events:[{message_id:dispatch}],next_after:null},error:null}:{data:{event_ids:[dispatch]},error:null})
 const host=createDesktopAssistantWorkHistory({context:async()=>({ownerId:'owner',deviceId:'desktop',runtimeInstanceId:'runtime',client:{rpc}}),
  receipts:async()=>({entries:[{id:dispatch,position:1,sessionId:child,title:'Work',timestamp:'2026-10-20T08:00:00Z',spawnedBySessionId:coordinator,spawnedByRemote:null,
    content:envelope(dispatch,coordinator,`Decorated native request\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`)}],cursor:1,hasMore:false}),
  identity:async(session:string)=>({id:session===child?executor:assistant,createdAt:Date.parse('2026-10-19T08:00:00Z')}),assistant:async()=>assistant,warn:vi.fn()})
 await host.kick();host.stop()
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['assistant_work_history'])
})

it('persists the scan position and retries only failed receipt positions after a restart',async()=>{
 const entry={id:dispatch,position:7,sessionId:child,title:'Work',timestamp:'2026-10-20T08:00:00Z',spawnedBySessionId:coordinator,spawnedByRemote:null,
  content:envelope(dispatch,coordinator,`Old request\n<gugu_work>\n${JSON.stringify({work_id:workId,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`)}
 let saved={after:0,retry:[] as number[]},unavailable=true
 const receipts=vi.fn(async(after:number,retry:number[]=[])=>({entries:after<7||retry.includes(7)?[entry]:[],cursor:Math.max(after,7),hasMore:false,pending:[]}))
 const rpc=vi.fn(async(name:string)=>name==='assistant_work_history'?{data:null,error:{code:'42501',message:'Work is not available to this account'}}
   :unavailable?{data:null,error:{code:'503',message:'Unavailable'}}:{data:{event_ids:[dispatch]},error:null})
 const deps={context:async()=>({ownerId:'owner',deviceId:'desktop',runtimeInstanceId:'runtime',client:{rpc}}),receipts,
  checkpoint:{read:async()=>saved,write:async(_owner:string,value:typeof saved)=>{saved=value}},
  identity:async(session:string)=>({id:session===child?executor:assistant,createdAt:Date.parse('2026-10-19T08:00:00Z')}),assistant:async()=>assistant,warn:vi.fn()}
 const first=createDesktopAssistantWorkHistory(deps);await first.kick();first.stop()
 expect(saved).toEqual({after:7,retry:[7]})
 unavailable=false
 const second=createDesktopAssistantWorkHistory(deps);await second.kick();await second.kick();second.stop()
 expect(receipts.mock.calls.map(call=>call[0])).toEqual([0,7,7])
 expect(receipts.mock.calls[1]![1]).toEqual([7])
 expect(saved).toEqual({after:7,retry:[]})
})
