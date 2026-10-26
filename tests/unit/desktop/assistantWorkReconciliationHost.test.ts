import { expect, it, vi } from 'vitest'
import { createDesktopAssistantWorkReconciler } from '../../../apps/desktop/electron/assistant-work-reconciliation'

it('filters pending reconciliation before paging and resumes a bounded page on the next pass', async () => {
  const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_list'?{items:[],next_before:'next-page'}:{events:[]},error:null}))
  const reconciler=createDesktopAssistantWorkReconciler({
    context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',client:{rpc}}),
    assistant:async()=>({agentId:'assistant',deviceId:'cloud',sessionId:'current-session'}), inspect:async()=>null,
    notify:async()=>({chatId:'dm',messageId:'post'}),verifyOwnerPost:async()=>true,clean:vi.fn(),warn:vi.fn(),
  })
  await reconciler.kick()
  expect(rpc.mock.calls.filter(([name])=>name==='assistant_work_list')).toHaveLength(1)
  expect(rpc).toHaveBeenCalledWith('assistant_work_list',expect.objectContaining({p_reconcile_only:true,p_before:null,p_limit:100}))
  await reconciler.kick()
  expect(rpc).toHaveBeenCalledWith('assistant_work_list',expect.objectContaining({p_reconcile_only:true,p_before:'next-page'}))
  reconciler.stop()
})

it('binds the real current coordinator before reading tasks, once per runtime/session',async()=>{
  const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_list'?{items:[],next_before:null}:{events:[]},error:null}))
  let sessionId='actual-gugu-session'
  const reconciler=createDesktopAssistantWorkReconciler({
    context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',client:{rpc}}),
    assistant:async()=>({agentId:'assistant',deviceId:'cloud',sessionId}),inspect:async()=>null,
    notify:async()=>({chatId:'dm',messageId:'post'}),verifyOwnerPost:async()=>true,clean:vi.fn(),warn:vi.fn(),
  })
  await reconciler.kick();await reconciler.kick()
  expect(rpc).toHaveBeenCalledWith('assistant_work_coordinator_bind',{p_assistant:'assistant',p_runtime_instance_id:'runtime',p_session_id:'actual-gugu-session'})
  expect(rpc.mock.calls.filter(([name])=>name==='assistant_work_coordinator_bind')).toHaveLength(1)
  expect(rpc.mock.calls[0]?.[0]).toBe('assistant_work_coordinator_bind')
  sessionId='new-gugu-session';await reconciler.kick()
  expect(rpc.mock.calls.filter(([name])=>name==='assistant_work_coordinator_bind')).toHaveLength(2)
  reconciler.stop()
})
