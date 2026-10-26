import { expect, it, vi } from 'vitest'
import { createAssistantWorkAvailabilityNotifier, ASSISTANT_WORK_AVAILABILITY_NOTICE } from '../../../../packages/core/src/cloud/assistantWorkAvailability'

const context={ownerId:'owner',deviceId:'mac',runtimeInstanceId:'runtime'}
function fixture() {
  let live:typeof context|null={...context}
  const posts=new Map<string,Record<string,unknown>>()
  const rpc=vi.fn(async(_ctx:typeof context,name:string,args:Record<string,unknown>)=>{
    if(name==='open_dm')return {data:'assistant-chat',error:null}
    posts.set(args.p_message_id as string,args)
    return {data:[{id:args.p_message_id}],error:null}
  })
  const visible=vi.fn(async()=>true)
  const deps={context:async()=>live,assistant:vi.fn(async()=> 'assistant'),rpc,visible}
  return {deps,posts,change:(value:typeof context|null)=>{live=value}}
}
it('uses one ordinary committed message across devices, process restarts and changing private error codes',async()=>{
  const f=fixture()
  await createAssistantWorkAvailabilityNotifier(f.deps)(context,{code:'PGRST202'},new AbortController().signal)
  const other={...context,deviceId:'phone',runtimeInstanceId:'phone-runtime'}
  f.change(other)
  await createAssistantWorkAvailabilityNotifier(f.deps)(other,{code:'private network error'},new AbortController().signal)
  expect(f.posts.size).toBe(1)
  expect([...f.posts.values()][0]).toMatchObject({p_content:ASSISTANT_WORK_AVAILABILITY_NOTICE,p_chat_id:'assistant-chat',p_sender_user_id:'assistant',p_to_user_ids:['owner']})
  expect(JSON.stringify([...f.posts.values()])).not.toContain('PGRST202')
  expect(f.deps.visible).toHaveBeenCalledTimes(2)
})
it('does not treat an invisible or uncommitted notice as sent',async()=>{
  const f=fixture();f.deps.visible.mockResolvedValue(false)
  await expect(createAssistantWorkAvailabilityNotifier(f.deps)(context,{code:'NETWORK'},new AbortController().signal)).rejects.toThrow('not committed')
})
it('refuses a late post after the account changes during assistant lookup',async()=>{
  const f=fixture()
  f.deps.assistant.mockImplementation(async()=>{f.change({...context,ownerId:'another-owner'});return 'assistant'})
  await expect(createAssistantWorkAvailabilityNotifier(f.deps)(context,{code:'NETWORK'},new AbortController().signal)).rejects.toThrow('account changed')
  expect(f.deps.rpc).not.toHaveBeenCalled()
})
it('does not post when the queue host has already stopped the notice attempt',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort(new Error('host stopped'))
  await expect(createAssistantWorkAvailabilityNotifier(f.deps)(context,{code:'NETWORK'},controller.signal)).rejects.toThrow('host stopped')
  expect(f.deps.rpc).not.toHaveBeenCalled()
})
