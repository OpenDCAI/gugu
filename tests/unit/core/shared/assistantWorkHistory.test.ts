import {expect,it} from 'vitest'
import {buildSessionDirectEnvelope} from '@gugu/core/local/agent/deliveryEnvelope'
import {legacyAssistantDispatch,legacyAssistantReports} from '@gugu/core/shared/assistantWorkHistory'
const work='10000000-0000-4000-8000-000000000001',message='10000000-0000-4000-8000-000000000002',coordinator='10000000-0000-4000-8000-000000000003',assistant='10000000-0000-4000-8000-000000000004',executor='10000000-0000-4000-8000-000000000005',session='10000000-0000-4000-8000-000000000006'
const caller={sessionId:coordinator,deviceId:'home',agentUserId:assistant}
const agent={sessionId:session,agentUserId:executor,displayName:'Phone task',caller}
const body=`Original instructions\n\n<gugu_work>\n${JSON.stringify({work_id:work,coordinator:`session:${coordinator}`,report:'Report results'})}\n</gugu_work>`
const job={id:message,createdAt:'2026-10-20T08:00:00Z',prompt:buildSessionDirectEnvelope({senderSessionId:coordinator,senderTitle:'Assistant',messageId:message,content:body,at:'2026-10-20T08:00:00Z'}),route:{kind:'session-direct',caller,sourceMessageId:message},sent:['tool-one']}
it('extracts only a host-correlated legacy dispatch with the original ids, body and receipt time',()=>{
 const record=legacyAssistantDispatch({agent,job,deviceId:'phone'})!
 expect(record).toMatchObject({assistantId:assistant,workId:work,task:{coordinator_session_id:coordinator,coordinator_device_id:'home',executors:[{session_id:session,device_id:'phone',agent_user_id:executor}]},event:{message_id:message,content:body,receipt_kind:'received',occurred_at:'2026-10-20T08:00:00.000Z'}})
 expect(legacyAssistantDispatch({agent,job:{...job,route:{...job.route,caller:{...caller,sessionId:session}}},deviceId:'phone'})).toBeNull()
 expect(legacyAssistantDispatch({agent,job:{...job,prompt:'a person quoted <gugu_work>'},deviceId:'phone'})).toBeNull()
})
it('imports only successful original report receipts, never unexecuted calls or inferred completion',()=>{
 const record=legacyAssistantDispatch({agent,job,deviceId:'phone'})!
 const tool={type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'tool-one',name:'session_message',arguments:{to:[`session:${coordinator}`],text:'Verified',work_result:{work_id:work,status:'completed'}}}]}}
 const receipt={type:'message',timestamp:'2026-10-20T08:02:00Z',message:{role:'toolResult',toolCallId:'tool-one',isError:false,details:{recipients:[{to:`session:${coordinator}`,status:'delivered',message_id:executor}]}}}
 expect(legacyAssistantReports(record,job,[tool])).toEqual([])
 expect(legacyAssistantReports(record,job,[tool,{...receipt,message:{...receipt.message,isError:true}}])).toEqual([])
 expect(legacyAssistantReports(record,job,[tool,receipt])).toMatchObject([{message_id:executor,kind:'completed',content:'Verified',receipt_kind:'sent_admitted',from_session_id:session,to_session_id:coordinator}])
 const plain={...tool,message:{...tool.message,content:[{...tool.message.content[0],arguments:{to:[`session:${coordinator}`],text:'Done'}}]}}
 expect(legacyAssistantReports(record,job,[plain,receipt])[0]!.kind).toBe('progress')
})
