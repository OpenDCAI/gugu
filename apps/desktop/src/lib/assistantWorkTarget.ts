import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import {assistantWorkCloud} from './assistantWork'
import type {AssistantTaskChat} from './assistantTaskChat'

export function assistantWorkTarget(work:AssistantWorkTask,sessionId?:string):AssistantTaskChat|null {
  const executor=sessionId?work.executors.find(row=>row.session_id===sessionId):work.executors.length===1?work.executors[0]:null
  return executor?{workId:work.work_id,title:work.title,assistantId:work.assistant_user_id,taskAgentId:executor.agent_user_id??null,
    task:{sessionId:executor.session_id,deviceId:executor.device_id},assistants:[{sessionId:work.coordinator_session_id,deviceId:work.coordinator_device_id}]}:null
}

/** A link reads its own account facts, independent of the task panel's cache or device directory. */
export async function resolveAssistantWorkTarget(assistantId:string,target:{sessionId?:string;agentId?:string}):Promise<AssistantTaskChat|null>{
  const matches=(await assistantWorkCloud.listAll(assistantId)).flatMap(work=>work.executors
    .filter(executor=>target.sessionId?executor.session_id===target.sessionId:executor.agent_user_id===target.agentId)
    .map(executor=>assistantWorkTarget(work,executor.session_id)!))
  return matches.length===1?matches[0]!:null
}
