import {useMemo,useSyncExternalStore} from 'react'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
import {assistantWorkCloud,watchAssistantWork} from '../../lib/assistantWork'
import {assistantWorkRefresh} from './assistant-work-refresh'
import {rendererLogger} from '../../lib/log'

type Value={records:AssistantWorkTask[];error?:unknown}|null
function createRecords(owner:string,assistant:string){
 let value:Value=null,stop:(()=>void)|undefined,pending:ReturnType<typeof assistantWorkRefresh>|undefined,generation=0
 const listeners=new Set<()=>void>()
 const notify=()=>{for(const listener of [...listeners])listener()}
 return {
  read:()=>value,
  refresh:()=>{void pending?.refresh()},
  subscribe:(listener:()=>void)=>{
   listeners.add(listener)
   if(listeners.size===1){
    const current=++generation
    pending=assistantWorkRefresh(async()=>{
     try{
      const records=await assistantWorkCloud.listAll(assistant)
      if(current===generation){value={records};notify()}
     }catch(error){
      if(current!==generation)return
      rendererLogger('assistant/work').warn({error},'account task read failed')
      value={records:value?.records??[],error};notify()
     }
    })
    stop=watchAssistantWork(owner,assistant,()=>void pending?.refresh())
    void pending.refresh()
   }
   return()=>{
    listeners.delete(listener)
    if(!listeners.size){generation++;pending?.close();pending=undefined;stop?.();stop=undefined}
   }
  },
 }
}
const records=new Map<string,ReturnType<typeof createRecords>>()
const absent=()=>null,noop=()=>()=>{}

/** Source badges and both task panes share one account read and subscription. */
export function useAssistantWorkRecords(owner:string|null|undefined,assistant:string){
 const store=useMemo(()=>{
  if(!owner)return null
  const key=JSON.stringify([owner,assistant])
  let store=records.get(key)
  if(!store){store=createRecords(owner,assistant);records.set(key,store)}
  return store
 },[owner,assistant])
 const value=useSyncExternalStore(store?.subscribe??noop,store?.read??absent)
 return {value,reload:store?.refresh??(()=>{})}
}
