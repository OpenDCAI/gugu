import {useEffect,useState} from 'react'
import {isAssistantPanelReadRetryable} from '@gugu/core/cloud/assistantPanelRead'
import {assistantWorkCloud,watchAssistantWork} from '../../lib/assistantWork'
import {assistantWorkRefresh} from './assistant-work-refresh'
import {rendererLogger} from '../../lib/log'

type Detail=Awaited<ReturnType<typeof assistantWorkCloud.get>>
type Read={key:string;detail:Detail|null;error?:unknown}
const cache=new Map<string,Detail>()

/** Neither executor admission nor a host connection gates the page's first paint. */
export function useAssistantWorkDetail(ownerId:string,assistantId:string,workId:string,sessionId:string){
 const key=JSON.stringify([ownerId,assistantId,workId,sessionId])
 const [read,setRead]=useState<Read|null>(null)
 useEffect(()=>{
  let alive=true,failures=0
  let timer:ReturnType<typeof setTimeout>|undefined
  const pending=assistantWorkRefresh(async()=>{
   clearTimeout(timer)
   try{
    const detail=await assistantWorkCloud.get(assistantId,workId)
    if(detail.work.owner_user_id!==ownerId||detail.work.assistant_user_id!==assistantId||detail.work.work_id!==workId
      ||!detail.work.executors.some(row=>row.session_id===sessionId))throw new Error('Task address does not match its account record')
    if(alive){failures=0;cache.set(key,detail);setRead({key,detail})}
   }catch(error){
    if(!alive)return
    rendererLogger('assistant/work-open').warn({error},'account work detail read failed')
    setRead({key,detail:cache.get(key)??null,error})
    if(failures++<2&&isAssistantPanelReadRetryable(error))timer=setTimeout(()=>void pending.refresh(),1500)
   }
  })
  const stop=watchAssistantWork(ownerId,assistantId,()=>void pending.refresh())
  void pending.refresh()
  return()=>{alive=false;pending.close();stop();clearTimeout(timer)}
 },[key,ownerId,assistantId,workId,sessionId])
 return read?.key===key?read:{key,detail:cache.get(key)??null}
}
