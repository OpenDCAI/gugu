import { useEffect,useState } from 'react'
import type { AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import { assistantWorkCloud,watchAssistantWork } from '../../lib/assistantWork'
import { getAgentPresenceSnapshot,subscribeAgentPresence } from '../../lib/agentPresenceStore'
import { OPEN_ASSISTANT_TASK_CHAT,type AssistantTaskChat } from '../../lib/assistantTaskChat'
import { assistantWorkTasks,assistantWorkStatus } from './assistant-work-projection'
import { rendererLogger } from '../../lib/log'
import {assistantWorkRefresh} from './assistant-work-refresh'

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
export type AssistantWorkTasksRead = {state:'loading'} | {state:'error';error:unknown;data:AssistantPanelTask[]} | {state:'ok';data:AssistantPanelTask[]}
type Cached = {records:AssistantWorkTask[];error?:unknown}
const cache=new Map<string,Cached>()
export function useAssistantWorkTasks(ownerId:string|null|undefined,assistantId:string):AssistantWorkTasksRead & {reload:()=>void} {
  const key=ownerId ? `${ownerId}:${assistantId}` : null
  const [result,setResult]=useState<({key:string}&Cached)|null>(()=>key&&cache.has(key)?{key,...cache.get(key)!}:null)
  const [,revision]=useState(0)
  const [attempt,reload]=useState(0)
  useEffect(()=>{
    if(!key || !ownerId) return
    let alive=true
    const pending=assistantWorkRefresh(async()=>{
      try {
        const records=await assistantWorkCloud.listAll(assistantId)
        if(alive){cache.set(key,{records});setResult({key,records})}
      } catch(error) {
        if(alive) {
          rendererLogger('assistant/work').warn({error},'account task read failed')
          const value={records:cache.get(key)?.records??[],error}
          cache.set(key,value);setResult({key,...value})
        }
      }
    })
    const stop=watchAssistantWork(ownerId,assistantId,()=>{void pending.refresh()})
    void pending.refresh()
    return ()=>{alive=false;pending.close();stop()}
  },[key,ownerId,assistantId,attempt])
  const current=result?.key===key ? result : key?cache.get(key):undefined
  const records=current?.records??[]
  const agents=JSON.stringify([...new Set(records.flatMap(work=>work.executors.flatMap(executor=>executor.agent_user_id ? [executor.agent_user_id] : [])))].sort())
  useEffect(()=>{
    const stops=(JSON.parse(agents) as string[]).map(agentId=>subscribeAgentPresence(agentId,()=>revision(n=>n+1)))
    return ()=>{for(const stop of stops) stop()}
  },[agents])
  const read:AssistantWorkTasksRead=!current || !key ? {state:'loading'} : current.error ? {state:'error',error:current.error,data:rows(records)} : {state:'ok',data:rows(records)}
  return {...read,reload:()=>reload(n=>n+1)}
}
