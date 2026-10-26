import { useEffect,useState } from 'react'
import type { AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import { assistantWorkCloud } from '../../lib/assistantWork'
import {assistantWorkPresence as getAgentPresenceSnapshot,subscribeAssistantWorkPresence as subscribeAgentPresence} from '../../lib/assistantWorkReadBridge'
import { OPEN_ASSISTANT_TASK_CHAT,type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantWorkTasks,assistantWorkStatus } from './assistant-work-projection'
import {useAssistantWorkRecords} from './assistant-work-records'

type Scope = { ownerId:string;assistantId:string;assertCurrent?:()=>void }
const rows = (records:readonly AssistantWorkTask[]) => assistantWorkTasks(records).map(task => {
  const presence=task.agentId ? getAgentPresenceSnapshot(task.agentId) : null
  return { ...task,status:assistantWorkStatus(task.outcome,presence?.reading ?? null),
    harness:presence?.payload?.agentType ?? null,unseen:presence?.local?.unseen ?? false }
})
/** Both shells share this cloud read; no home readiness or observed session directory participates. */
export async function readAssistantPanelTasks(scope:Scope) {
  scope.assertCurrent?.()
  const records=await assistantWorkCloud.listAll(scope.assistantId)
  scope.assertCurrent?.()
  return rows(records)
}
export type AssistantPanelTask = ReturnType<typeof rows>[number]
export function openAssistantPanelTask(scope:Pick<Scope,'assistantId'>,task:AssistantPanelTask) {
  const detail:AssistantTaskChat={workId:task.workId,title:task.title,assistantId:scope.assistantId,taskAgentId:task.agentId,
    task:{deviceId:task.deviceId,sessionId:task.id},assistants:task.assistants}
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail}))
}
export type AssistantWorkTasksRead = {state:'loading'} | {state:'error';error:unknown;data:AssistantPanelTask[]} | {state:'ok';data:AssistantPanelTask[]}
export function useAssistantWorkTasks(ownerId:string|null|undefined,assistantId:string):AssistantWorkTasksRead & {reload:()=>void} {
  const {value:current,reload}=useAssistantWorkRecords(ownerId,assistantId)
  const [,revision]=useState(0)
  const records=current?.records??[]
  const agents=JSON.stringify([...new Set(records.flatMap(work=>work.executors.flatMap(executor=>executor.agent_user_id ? [executor.agent_user_id] : [])))].sort())
  useEffect(()=>{
    const stops=(JSON.parse(agents) as string[]).map(agentId=>subscribeAgentPresence(agentId,()=>revision(n=>n+1)))
    return ()=>{for(const stop of stops) stop()}
  },[agents])
  const read:AssistantWorkTasksRead=!current ? {state:'loading'} : current.error ? {state:'error',error:current.error,data:rows(records)} : {state:'ok',data:rows(records)}
  return {...read,reload}
}
