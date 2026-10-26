import {useSyncExternalStore} from 'react'
import {AssistantWorkError,type AssistantWorkClient} from '@gugu/core/cloud/assistantWork'
import type {AgentPresenceState,AgentPresenceListener} from './agentPresenceStore'
import {readSelfIdentityBridge} from './selfIdentityBridge'

type WorkReads={
  client:Pick<AssistantWorkClient,'listAll'|'historyAll'>
  watch(ownerId:string,assistantId:string,refresh:()=>void):()=>void
  presence(agentId:string):AgentPresenceState|null
  subscribePresence(agentId:string,listener:AgentPresenceListener):()=>void
}
const KEY='__GUGU_ASSISTANT_WORK_READS__',CHANGED='__gugu_assistant_work_reads_changed'
type WorkWindow=Window&{[KEY]?:WorkReads}
const read=()=>typeof window==='undefined'?undefined:(window as WorkWindow)[KEY]
const required=()=>{const bridge=read();if(!bridge)throw new AssistantWorkError('unprepared','Account task reader is unavailable');return bridge}
/** Installed only by the authenticated shell. No token crosses the bundle boundary. */
export function installAssistantWorkReadBridge(value:WorkReads){
  const target=window as WorkWindow;target[KEY]=value;window.dispatchEvent(new Event(CHANGED))
  return ()=>{if(target[KEY]===value){delete target[KEY];window.dispatchEvent(new Event(CHANGED))}}
}
export const assistantWorkCloud:WorkReads['client']={
  listAll:assistant=>required().client.listAll(assistant),
  historyAll:(assistant,work)=>required().client.historyAll(assistant,work),
}
export function watchAssistantWork(owner:string,assistant:string,refresh:()=>void){
  let stop:(()=>void)|undefined
  const bind=()=>{stop?.();stop=read()?.watch(owner,assistant,refresh);refresh()}
  window.addEventListener(CHANGED,bind);stop=read()?.watch(owner,assistant,refresh)
  return ()=>{stop?.();window.removeEventListener(CHANGED,bind)}
}
export const assistantWorkPresence=(agent:string)=>read()?.presence(agent)??null
export const subscribeAssistantWorkPresence=(agent:string,listener:AgentPresenceListener)=>read()?.subscribePresence(agent,listener)??(()=>{})
const owner=()=>readSelfIdentityBridge()?.getSnapshot()?.userId??null
const subscribeOwner=(listener:()=>void)=>readSelfIdentityBridge()?.subscribe(listener)??(()=>{})
/** The session-page React root has no shell AuthContext. */
export const useAssistantWorkOwnerId=()=>useSyncExternalStore(subscribeOwner,owner,()=>null)
