import '@/i18n/registerAssistantCatalog'
import { useTranslation } from 'react-i18next'
import { isCloudComputerNotOpen } from '@gugu/core/cloud/cloudComputer'
import { rendererLogger } from '@/lib/log'
import { useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore } from 'react'
import type { ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { getRendererSession,observeRendererSession } from '@/lib/sessionPublication'
import { assistantPanelCacheStore } from '@/components/assistant/assistant-panel-cache'
import { ASSISTANT_PANEL_CHANGED } from '@/components/assistant/assistant-panel-events'

export type ChatChannelsStatus='loading'|'ready'|'absent'|'failed'
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
  const {t}=useTranslation('assistant')
  const owner=useSyncExternalStore(subscribe,account,()=>null)
  const client=useMemo(()=>rendererChatChannelsClient(),[])
  const cache=useMemo(()=>assistantPanelCacheStore().accountState(owner??'','application-connections:wechat',isList),[owner])
  const initial=()=>{const list=client?cache.peek()??null:null;return {owner,list,status:!client?'absent' as const:list?'ready' as const:owner?'loading' as const:'failed' as const,error:''}}
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
      if(isCloudComputerNotOpen(error)){setState({owner,list:null,status:'absent',error:''});return}
      rendererLogger('settings/connections').warn({error},'application connection status unavailable')
      setState(previous=>{
        const list=previous.owner===owner?previous.list:cache.peek()??null
        return {owner,list,status:list?'ready':'failed',error:t('connectors.loadFailed')}
      })
    }
  },[client,owner,apply,cache,t])
  useEffect(()=>{
    const changed=()=>{const local=client?cache.peek():null;if(local&&currentOwner.current===owner)setState(previous=>previous.status==='absent'?previous:{owner,list:local,status:'ready',error:''})}
    window.addEventListener(ASSISTANT_PANEL_CHANGED,changed)
    void refresh();const timer=setInterval(()=>void refresh(),REFRESH_MS)
    return()=>{clearInterval(timer);window.removeEventListener(ASSISTANT_PANEL_CHANGED,changed)}
  },[refresh,cache,owner,client])
  const current=state.owner===owner?state:initial()
  return {client,...current,refresh,apply}
}
