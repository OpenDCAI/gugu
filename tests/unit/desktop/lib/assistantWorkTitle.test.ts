import {expect,it} from 'vitest'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import type {Device} from '@gugu/core/shared/types/chat'
import {assistantWorkTitleSignature,withAssistantWorkTitle} from '../../../../apps/desktop/src/lib/assistantWorkTitle'

const work={owner_user_id:'owner',title:'任务',executors:[{device_id:'mac',session_id:'task'}]} as AssistantWorkTask
const devices=[{device_id:'mac',session_digest:[{conversationId:'task',title:'复测回复「收到，测试正文」'}]}] as Device[]
it('recovers an old placeholder from the exact same-account device and session without changing stored facts',()=>{
  const projected=withAssistantWorkTitle(work,'owner','owner',devices)
  expect(projected.title).toBe('复测回复「收到，测试正文」')
  expect(work.title).toBe('任务')
  expect({...projected,title:work.title}).toEqual(work)
})
it('keeps named work, unknown tasks and foreign or ambiguous cache entries unchanged',()=>{
  const named={...work,title:'交付报告'}
  expect(withAssistantWorkTitle(named,'owner','owner',devices)).toBe(named)
  expect(withAssistantWorkTitle(work,'owner','someone-else',devices)).toBe(work)
  expect(withAssistantWorkTitle(work,'someone-else','someone-else',devices)).toBe(work)
  expect(withAssistantWorkTitle(work,'owner','owner',[{...devices[0]!,device_id:'another'}])).toBe(work)
  expect(withAssistantWorkTitle(work,'owner','owner',[])).toBe(work)
  const ambiguous=[{...devices[0]!,session_digest:[...devices[0]!.session_digest!,...devices[0]!.session_digest!]}]
  expect(withAssistantWorkTitle(work,'owner','owner',ambiguous)).toBe(work)
})
it('refreshes title evidence independently of heartbeat status and device order',()=>{
  const signature=assistantWorkTitleSignature('owner','owner',devices)
  expect(assistantWorkTitleSignature('owner','someone-else',devices)).toBe('')
  expect(assistantWorkTitleSignature('owner','owner',devices.map(row=>({...row,is_online:false})))).toBe(signature)
  expect(assistantWorkTitleSignature('owner','owner',[])).not.toBe(signature)
  expect(assistantWorkTitleSignature('owner','owner',[{...devices[0]!,session_digest:[{...devices[0]!.session_digest![0]!,title:'New title'}]}])).not.toBe(signature)
})
