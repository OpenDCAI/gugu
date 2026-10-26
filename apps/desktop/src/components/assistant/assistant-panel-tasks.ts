import { useEffect,useState } from 'react'
import type { AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import { assistantWorkCloud,watchAssistantWork } from '../../lib/assistantWork'
import { getAgentPresenceSnapshot,subscribeAgentPresence } from '../../lib/agentPresenceStore'
import { OPEN_ASSISTANT_TASK_CHAT,type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantWorkTasks,assistantWorkStatus } from './assistant-work-projection'
import { rendererLogger } from '../../lib/log'

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
  if(!task.agentId) return
  const detail:AssistantTaskChat={workId:task.workId,assistantId:scope.assistantId,taskAgentId:task.agentId,
    task:{deviceId:task.deviceId,sessionId:task.id},assistants:task.assistants}
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail}))
}
type Read = {state:'loading'} | {state:'error';error:unknown} | {state:'ok';data:AssistantPanelTask[]}
export function useAssistantWorkTasks(ownerId:string|null|undefined,assistantId:string):Read & {reload:()=>void} {
  const key=ownerId ? `${ownerId}:${assistantId}` : null
  const [result,setResult]=useState<{key:string;records:AssistantWorkTask[];error?:unknown}|null>(null)
  const [,revision]=useState(0)
  const [attempt,reload]=useState(0)
  useEffect(()=>{
    if(!key || !ownerId) return
    let alive=true,version=0
    const refresh=async()=>{
      const current=++version
      try {
        const records=await assistantWorkCloud.listAll(assistantId)
        if(alive && current===version) setResult({key,records})
      } catch(error) {
        if(alive && current===version) {
          rendererLogger('assistant/work').warn({error},'account task read failed')
          setResult(previous=>previous?.key===key && previous.records.length ? previous : {key,records:[],error})
        }
      }
    }
    const stop=watchAssistantWork(ownerId,assistantId,()=>{void refresh()})
    void refresh()
    return ()=>{alive=false;stop()}
  },[key,ownerId,assistantId,attempt])
  const records=result?.key===key ? result.records : []
  const agents=JSON.stringify([...new Set(records.flatMap(work=>work.executors.flatMap(executor=>executor.agent_user_id ? [executor.agent_user_id] : [])))].sort())
  useEffect(()=>{
    const stops=(JSON.parse(agents) as string[]).map(agentId=>subscribeAgentPresence(agentId,()=>revision(n=>n+1)))
    return ()=>{for(const stop of stops) stop()}
  },[agents])
  const read:Read=result?.key!==key || !key ? {state:'loading'} : result.error ? {state:'error',error:result.error} : {state:'ok',data:rows(records)}
  return {...read,reload:()=>reload(n=>n+1)}
}
