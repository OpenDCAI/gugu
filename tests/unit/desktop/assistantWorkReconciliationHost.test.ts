import { expect, it, vi } from 'vitest'
import { createDesktopAssistantWorkReconciler } from '../../../apps/desktop/electron/assistant-work-reconciliation'

it('filters pending reconciliation before paging and resumes a bounded page on the next pass', async () => {
  const rpc=vi.fn(async(name:string)=>({data:name==='assistant_work_list'?{items:[],next_before:'next-page'}:{events:[]},error:null}))
  const reconciler=createDesktopAssistantWorkReconciler({
    context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'cloud',client:{rpc}}),
    assistant:async()=>({agentId:'assistant',deviceId:'cloud'}), inspect:async()=>null,
    notify:async()=>({chatId:'dm',messageId:'post'}),verifyOwnerPost:async()=>true,clean:vi.fn(),warn:vi.fn(),
  })
  await reconciler.kick()
  expect(rpc.mock.calls.filter(([name])=>name==='assistant_work_list')).toHaveLength(1)
  expect(rpc).toHaveBeenCalledWith('assistant_work_list',expect.objectContaining({p_reconcile_only:true,p_before:null,p_limit:100}))
  await reconciler.kick()
  expect(rpc).toHaveBeenCalledWith('assistant_work_list',expect.objectContaining({p_reconcile_only:true,p_before:'next-page'}))
  reconciler.stop()
})
