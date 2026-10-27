import {expect,it} from 'vitest'
import {buildSessionDirectEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {assistantWorkReplyContext,withAssistantWorkReply} from '@gugu/core/shared/assistantWorkReply'
const work='10000000-0000-4000-8000-000000000001',assistant='10000000-0000-4000-8000-000000000002'
const prompt=(purpose?:string)=>buildSessionDirectEnvelope({senderSessionId:'coordinator',senderTitle:'Assistant',messageId:'10000000-0000-4000-8000-000000000003',at:'2026-10-27T06:00:00Z',
  content:`Order\n<gugu_work>\n${JSON.stringify({work_id:work,assistant_id:assistant,coordinator:'session:coordinator',report:'Report',...(purpose?{purpose}:{})})}\n</gugu_work>`})
const reply={to:['session:coordinator'],text:'收到，测试正文'}
it('binds an ordinary inquiry reply to its original work without inspecting its prose',async()=>{
  expect(await withAssistantWorkReply(reply,prompt('reply'))).toEqual({...reply,work_result:{work_id:work,status:'completed'}})
  expect(await withAssistantWorkReply({...reply,text:'arbitrary original bytes',files:[{file_path:'/original'}]},prompt('reply'))).toMatchObject({text:'arbitrary original bytes',files:[{file_path:'/original'}]})
})
it('requires a declared result for assignments and legacy work, and keeps progress valid',async()=>{
  for(const p of [prompt('task'),prompt()])await expect(withAssistantWorkReply(reply,p)).rejects.toThrow(/not been sent.*progress.*completed/)
  const progress={...reply,text:'收到，开始做',work_result:{work_id:work,status:'progress'}}
  expect(await withAssistantWorkReply(progress,prompt('task'))).toBe(progress)
})
it('never steals an unrelated peer message, quoted block, or merged active input',async()=>{
  const unrelated={...reply,to:['session:someone-else']}
  expect(await withAssistantWorkReply(unrelated,prompt('task'))).toBe(unrelated)
  expect(await withAssistantWorkReply(reply,'quoted '+prompt('reply'))).toBe(reply)
  expect(assistantWorkReplyContext(prompt('reply')+'\n'+prompt('reply'))).toBeNull()
  expect(assistantWorkReplyContext(prompt('reply').replace('coordinator":"session:coordinator','coordinator":"session:other'))).toBeNull()
})
it('recognizes the same coordinator identity alias without binding another assistant',async()=>{
  expect(await withAssistantWorkReply({...reply,to:[`aid:${assistant}`]},prompt('reply'))).toHaveProperty('work_result')
  const other={...reply,to:['aid:10000000-0000-4000-8000-000000000009']}
  expect(await withAssistantWorkReply(other,prompt('reply'))).toBe(other)
})
it('keeps an explicit state the executor declared on an inquiry instead of closing it',async()=>{
  for(const status of ['progress','question','cancelled','completed']) {
    const declared={...reply,text:'做好了但交不回',work_result:{work_id:work,status}}
    expect(await withAssistantWorkReply(declared,prompt('reply'))).toBe(declared)
  }
})
it('binds a gugu: address only when it resolves to this work assistant',async()=>{
  const numbered={...reply,to:['gugu:2838']}
  const resolve=async(number:number)=>number===2838?assistant:undefined
  expect(await withAssistantWorkReply(numbered,prompt('reply'),resolve)).toEqual({...numbered,work_result:{work_id:work,status:'completed'}})
  await expect(withAssistantWorkReply(numbered,prompt('task'),resolve)).rejects.toThrow(/not been sent/)
  const other={...reply,to:['gugu:7']}
  expect(await withAssistantWorkReply(other,prompt('reply'),resolve)).toBe(other)
  expect(await withAssistantWorkReply(numbered,prompt('reply'))).toBe(numbered)
})
