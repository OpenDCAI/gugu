import { createAssistantWorkDeliveryReceiver } from '../../../packages/core/src/cloud/assistantWorkDelivery.ts'
import { enqueueAssistantWorkReport } from '../../../packages/core/src/cloud/assistantWorkReports.ts'
import { legacyAssistantDispatch } from '../../../packages/core/src/shared/assistantWorkHistory.ts'
import { stableId } from './phone-agent-store.mjs'
import { assistantWorkReplyContext } from '../../../packages/core/src/shared/assistantWorkReply.ts'

/** Uses only the shared account queue. No local delivery payload or second retry journal. */
export function createPhoneAssistantWork({ ownerId,deviceId,instanceId,cloud,store,isReady,invoke,kick }) {
  const receiver=createAssistantWorkDeliveryReceiver({
    context:async()=>isReady() ? {ownerId,deviceId} : null,
    read:async ref=>{
      let after='0'
      for(;;){
        const {data,error}=await cloud.identity.rpc('assistant_work_history',{p_assistant:ref.assistant_id,p_work_id:ref.work_id,p_after:after,p_limit:200})
        if(error) throw Object.assign(new Error(error.message),{code:error.code})
        if(!data || !Array.isArray(data.events)) throw new Error('Invalid account work history')
        const found=data.events.find(event=>event.message_id===ref.message_id)
        if(found) return found
        if(!data.next_after) return null
        if(BigInt(data.next_after)<=BigInt(after)) throw new Error('Account work history cursor did not advance')
        after=data.next_after
      }
    },
    deliver:async (event,signal)=>{
      const answer=await invoke('agentSession.message',[{sessionId:event.from_session_id,deviceId:event.from_device_id},
        {action:'message',session_ids:[event.to_session_id],text:event.content,attachments:event.attachment_refs,
          client_message_id:event.message_id,client_message_at:event.platform_received_at}],event.message_id,{kind:'device-rpc',signal})
      const admitted=answer?.recipients?.some(row=>row.message_id===event.message_id && row.status==='delivered')===true
      const agent=Object.values(store.state.agents).find(row=>row.sessionId===event.to_session_id)
      return {admitted,messageId:event.message_id,...(admitted && agent ? {receipt:{agent_user_id:agent.agentUserId}} : {})}
    },
  })
  const api={
    correlation:(agent,job)=>legacyAssistantDispatch({agent,job,deviceId}),
    receive:(ref,signal)=>receiver.receive(ref,ownerId,signal),
    async enqueueReport({agent,job,callId,record,prepare,reasonCode}) {
      // The host-bound dispatch names the assistant; whoever invoked this agent may be someone else.
      const assistantId=agent.assistantWork?.assistant_id ?? assistantWorkReplyContext(job.prompt)?.assistant_id ?? agent.caller?.agentUserId
      if(!assistantId) throw new Error('Assistant task routing is not available')
      let sequence=0
      const result=await enqueueAssistantWorkReport({rpc:(name,args)=>cloud.identity.rpc(name,args),prepare,
        resolveNumbers:async numbers=>{
          const {data,error}=await cloud.identity.from('active_users').select('id,gugu_number').eq('owner_user_id',ownerId).in('gugu_number',numbers)
          if(error) throw new Error(error.message)
          return new Map((data??[]).map(row=>[row.gugu_number,row.id]))
        },id:()=>stableId('phone-work-report',job.id,callId,sequence++)},
      {assistantId,runtimeInstanceId:instanceId,sessionId:agent.sessionId,deviceId,record,reasonCode})
      kick()
      return result
    },
    async enqueueHostFailure(agent,job) {
      const work=api.correlation(agent,job)
      if(!work) return false
      delete job.failureNotice
      if(job.hostFailureReported || job.sent?.length) return true
      const result=await api.enqueueReport({agent:{...agent,assistantWork:{assistant_id:work.assistantId}},job,callId:'host-failure',reasonCode:'HOST_FAILURE',
        record:{to:[`session:${work.task.coordinator_session_id}`],text:'这次手机任务没能完成，平台已单独发出失败说明，不用再转告。',work_result:{work_id:work.workId,status:'progress'}},
        prepare:async()=>[]})
      job.hostFailureReported={message_id:result.event_ids[0]}
      await store.save()
      return true
    },
  }
  return api
}
