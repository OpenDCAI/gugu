import { messageForUser } from '@/lib/userFacingError'
import { rendererLogger } from '@/lib/log'
import { useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore } from 'react'
import { isChatChannelsNotOpen,type ChatChannelList,type ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { getRendererSession,observeRendererSession } from '@/lib/sessionPublication'
import { assistantPanelCacheStore } from '@/components/assistant/assistant-panel-cache'
import { ASSISTANT_PANEL_CHANGED } from '@/components/assistant/assistant-panel-events'

export type ChatChannelsStatus='loading'|'ready'|'not_open'|'failed'
const REFRESH_MS=10_000
const subscribe=(listener:()=>void)=>observeRendererSession(()=>listener())
const account=()=>getRendererSession()?.user.id??null
function isList(value:unknown):value is ChatChannelList {
  if(!value||typeof value!=='object')return false
  const list=value as ChatChannelList
  return Array.isArray(list.channels)&&Array.isArray(list.kinds)&&(list.suggestedAgentId===null||typeof list.suggestedAgentId==='string')
    &&list.channels.every(item=>!!item&&typeof item.kind==='string'&&!!item.health&&['starting','running','paused','retrying','broken'].includes(item.health.state))
}
const reads=new Map<string,{at:number;promise:Promise<ChatChannelList>}>()
function readOnce(owner:string,client:ChatChannelsClient) {
  const current=reads.get(owner)
  if(current&&Date.now()-current.at<1000)return current.promise
  const entry={at:Date.now(),promise:client.list()};reads.set(owner,entry)
  void entry.promise.catch(()=>{if(reads.get(owner)===entry)reads.delete(owner)})
  return entry.promise
}

/** The real WeChat service shares the panel's account-scoped local store. */
export function useChatChannels(): {
  client:ChatChannelsClient|null;list:ChatChannelList|null;status:ChatChannelsStatus;error:string
  refresh:()=>Promise<void>;apply:(next:ChatChannelList)=>void
} {
  const owner=useSyncExternalStore(subscribe,account,()=>null)
  const client=useMemo(()=>rendererChatChannelsClient(),[])
  const cache=useMemo(()=>assistantPanelCacheStore().accountState(owner??'','application-connections:wechat',isList),[owner])
  const initial=()=>{const list=cache.peek()??null;return {owner,list,status:list?'ready' as const:client&&owner?'loading' as const:'not_open' as const,error:''}}
  const [state,setState]=useState<{owner:string|null;list:ChatChannelList|null;status:ChatChannelsStatus;error:string}>(initial)
  const currentOwner=useRef(owner);currentOwner.current=owner
  const apply=useCallback((next:ChatChannelList)=>{
    if(currentOwner.current!==owner)return
    cache.save(next);setState({owner,list:next,status:'ready',error:''})
  },[cache,owner])
  const refresh=useCallback(async()=>{
    if(!client||!owner)return
    try{apply(await readOnce(owner,client))}
    catch(error){
      if(currentOwner.current!==owner)return
      rendererLogger('settings/connections').warn({error},'application connection status unavailable')
      setState(previous=>{
        const list=previous.owner===owner?previous.list:cache.peek()??null
        return {owner,list,status:list?'ready':isChatChannelsNotOpen(error)?'not_open':'failed',error:messageForUser(error)}
      })
    }
  },[client,owner,apply,cache])
  useEffect(()=>{
    const changed=()=>{const local=cache.peek();if(local&&currentOwner.current===owner)setState({owner,list:local,status:'ready',error:''})}
    window.addEventListener(ASSISTANT_PANEL_CHANGED,changed)
    void refresh();const timer=setInterval(()=>void refresh(),REFRESH_MS)
    return()=>{clearInterval(timer);window.removeEventListener(ASSISTANT_PANEL_CHANGED,changed)}
  },[refresh,cache,owner])
  const current=state.owner===owner?state:initial()
  return {client,...current,refresh,apply}
}
