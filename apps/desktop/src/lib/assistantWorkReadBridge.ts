import {AssistantWorkError,type AssistantWorkClient} from '@gugu/core/cloud/assistantWork'
import type {AgentPresenceState,AgentPresenceListener} from './agentPresenceStore'
import {readAssistantPanelBridge,useAssistantPanelAccountId} from './assistantPanelBridge'

export type AssistantWorkReads={
  client:Pick<AssistantWorkClient,'listAll'|'historyAll'>
  watch(ownerId:string,assistantId:string,refresh:()=>void):()=>void
  presence(agentId:string):AgentPresenceState|null
  subscribePresence(agentId:string,listener:AgentPresenceListener):()=>void
}
const read=()=>readAssistantPanelBridge()?.work
const required=()=>{const work=read();if(!work)throw new AssistantWorkError('unprepared','Account task reader is unavailable');return work}
/** All cloud effects use the same authenticated App-shell bridge as the other panel domains. */
export const assistantWorkCloud:AssistantWorkReads['client']={
  listAll:assistant=>required().client.listAll(assistant),
  historyAll:(assistant,work)=>required().client.historyAll(assistant,work),
}
export const watchAssistantWork=(owner:string,assistant:string,refresh:()=>void)=>read()?.watch(owner,assistant,refresh)??(()=>{})
export const assistantWorkPresence=(agent:string)=>read()?.presence(agent)??null
export const subscribeAssistantWorkPresence=(agent:string,listener:AgentPresenceListener)=>read()?.subscribePresence(agent,listener)??(()=>{})
export const useAssistantWorkOwnerId=useAssistantPanelAccountId
