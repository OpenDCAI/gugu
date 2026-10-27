import {expect,it} from 'vitest'
import {buildSessionDirectEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {assistantWorkReplyContext,withAssistantWorkReply} from '@gugu/core/shared/assistantWorkReply'
const work='10000000-0000-4000-8000-000000000001',assistant='10000000-0000-4000-8000-000000000002'
const prompt=(purpose?:string)=>buildSessionDirectEnvelope({senderSessionId:'coordinator',senderTitle:'Assistant',messageId:'10000000-0000-4000-8000-000000000003',at:'2026-10-27T06:00:00Z',
  content:`Order\n<gugu_work>\n${JSON.stringify({work_id:work,assistant_id:assistant,coordinator:'session:coordinator',report:'Report',...(purpose?{purpose}:{})})}\n</gugu_work>`})
const reply={to:['session:coordinator'],text:'收到，测试正文'}
it('binds an ordinary inquiry reply to its original work without inspecting its prose',()=>{
  expect(withAssistantWorkReply(reply,prompt('reply'))).toEqual({...reply,work_result:{work_id:work,status:'completed'}})
  expect(withAssistantWorkReply({...reply,text:'arbitrary original bytes',files:[{file_path:'/original'}]},prompt('reply'))).toMatchObject({text:'arbitrary original bytes',files:[{file_path:'/original'}]})
})
it('requires a declared result for assignments and legacy work, and keeps progress valid',()=>{
  for(const p of [prompt('task'),prompt()])expect(()=>withAssistantWorkReply(reply,p)).toThrow(/not been sent.*progress.*completed/)
  const progress={...reply,text:'收到，开始做',work_result:{work_id:work,status:'progress'}}
  expect(withAssistantWorkReply(progress,prompt('task'))).toBe(progress)
})
it('never steals an unrelated peer message, quoted block, or merged active input',()=>{
  const unrelated={...reply,to:['session:someone-else']}
  expect(withAssistantWorkReply(unrelated,prompt('task'))).toBe(unrelated)
  expect(withAssistantWorkReply(reply,'quoted '+prompt('reply'))).toBe(reply)
  expect(assistantWorkReplyContext(prompt('reply')+'\n'+prompt('reply'))).toBeNull()
  expect(assistantWorkReplyContext(prompt('reply').replace('coordinator":"session:coordinator','coordinator":"session:other'))).toBeNull()
})
it('recognizes the same coordinator identity alias without binding another assistant',()=>{
  expect(withAssistantWorkReply({...reply,to:[`aid:${assistant}`]},prompt('reply'))).toHaveProperty('work_result')
  const other={...reply,to:['aid:10000000-0000-4000-8000-000000000009']}
  expect(withAssistantWorkReply(other,prompt('reply'))).toBe(other)
})
