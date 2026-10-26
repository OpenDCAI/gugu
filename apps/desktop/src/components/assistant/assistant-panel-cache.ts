import { parseAssistantPanelSnapshot,type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelReadCache } from '@gugu/core/cloud/assistantPanelCache'
import { getAgentWatchStore,type AgentWatchLocalStore,type LocalRow } from '@/session/shared/remote-sessions/local-store'
import { getRendererSession } from '@/lib/sessionPublication'
import { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'

const PREFIX='assistant-panel.v1:'
const HOT_KEY='gugu.assistantPanel.v1'
const MAX_BYTES=32*1024*1024, HOT_BYTES=1024*1024
const cachedDomains=new Set(['integrations','capabilities','device-notes'])
type CacheRow=LocalRow&{scope:string;owner:string;assistant:string;kind:'snapshot'|'body'|'account-state';value:unknown;bytes:number}
const encode=(bytes:Uint8Array)=>{let value='';for(let start=0;start<bytes.length;start+=8192)value+=String.fromCharCode(...bytes.subarray(start,start+8192));return btoa(value)}
const decode=(value:string)=>Uint8Array.from(atob(value),character=>character.charCodeAt(0))

/** One store for both bundles and all panel views. IndexedDB is the durable
 * copy; a bounded synchronous mirror supplies the first frame after restart. */
export function createAssistantPanelCacheStore(input:{store:()=>Promise<AgentWatchLocalStore>;hot:()=>Pick<Storage,'getItem'|'setItem'>;accountId:()=>string|null;changed:()=>void}) {
  const rows=new Map<string,CacheRow>()
  let tail=Promise.resolve(),stamp=0,hotTimer:ReturnType<typeof setTimeout>|undefined
  const nextStamp=()=>stamp=Math.max(Date.now(),stamp+1)
  function valid(value:unknown):CacheRow|undefined {
    if(!value||typeof value!=='object')return
    const row=value as CacheRow
    if(typeof row.key!=='string'||!row.key.startsWith(PREFIX)||typeof row.owner!=='string'||typeof row.assistant!=='string'
      ||row.scope!==JSON.stringify([row.owner,row.assistant])||typeof row.savedAt!=='number'||typeof row.bytes!=='number')return
    if(row.kind==='snapshot'){try{parseAssistantPanelSnapshot(row.value,row.owner,row.assistant)}catch{return}}
    else if(row.kind==='body'){if(typeof row.value!=='string')return}
    else if(row.kind!=='account-state'||!row.value||typeof row.value!=='object')return
    return row
  }
  function merge(row:CacheRow){if(!rows.has(row.key)||rows.get(row.key)!.savedAt<row.savedAt)rows.set(row.key,row);stamp=Math.max(stamp,row.savedAt)}
  try{const value=JSON.parse(input.hot().getItem(HOT_KEY)||'null');if(value?.version===1&&Array.isArray(value.rows))for(const raw of value.rows){const row=valid(raw);if(row)merge(row)}}catch{/* The durable copy can rebuild a missing mirror. */}
  const persist=(run:(store:AgentWatchLocalStore)=>Promise<void>)=>{tail=tail.then(async()=>run(await input.store())).catch(()=>undefined)}
  function mirror(){clearTimeout(hotTimer);hotTimer=setTimeout(()=>{
    const hot:CacheRow[]=[];let bytes=0
    for(const row of [...rows.values()].sort((a,b)=>Number(b.kind==='snapshot')-Number(a.kind==='snapshot')||b.savedAt-a.savedAt)){
      const size=JSON.stringify(row).length*2;if(bytes+size>HOT_BYTES)continue;bytes+=size;hot.push(row)
    }
    try{input.hot().setItem(HOT_KEY,JSON.stringify({version:1,rows:hot}))}catch{/* IndexedDB remains available when the mirror quota is full. */}
  },25)}
  function remove(key:string){rows.delete(key);persist(store=>store.delete('meta',key))}
  function save(row:CacheRow){merge(row);persist(store=>store.put('meta',row));let total=[...rows.values()].reduce((sum,row)=>sum+row.bytes,0)
    for(const old of [...rows.values()].sort((a,b)=>a.savedAt-b.savedAt)){if(total<=MAX_BYTES)break;if(old.key===row.key)continue;total-=old.bytes;remove(old.key)}mirror()}
  const ready=input.store().then(store=>store.readAll('meta')).then(saved=>{
    for(const raw of saved){const row=valid(raw);if(row)merge(row)}input.changed()
  }).catch(()=>undefined)
  function files(owner:string,assistant:string):AssistantPanelReadCache {
    const scope=JSON.stringify([owner,assistant]),prefix=PREFIX+scope+':',snapshotKey=prefix+'snapshot'
    const active=()=>input.accountId()===owner
    const snapshot=()=>{if(!active())return;const row=rows.get(snapshotKey);return row?parseAssistantPanelSnapshot(row.value,owner,assistant):undefined}
    const bodyKey=(item:AssistantPanelItem)=>prefix+'body:'+JSON.stringify([item.domain,item.resource_key,item.body_item_id,item.body_sha256])
    const live=(item:AssistantPanelItem)=>snapshot()?.items.some(row=>row.domain===item.domain&&row.resource_key===item.resource_key&&row.body_item_id===item.body_item_id&&row.body_sha256===item.body_sha256)
    function saveSnapshot(value:ReturnType<AssistantPanelReadCache['peekSnapshot']>) {
      if(!active()||!value)return
      const previous=snapshot();if(previous&&BigInt(previous.revision)>BigInt(value.revision))return
      save({key:snapshotKey,savedAt:nextStamp(),scope,owner,assistant,kind:'snapshot',value,bytes:JSON.stringify(value).length*2})
      const keys=new Set(value.items.filter(item=>item.body_item_id).map(bodyKey))
      for(const row of rows.values())if(row.scope===scope&&row.kind==='body'&&!keys.has(row.key))remove(row.key)
      mirror()
    }
    return {
      peekSnapshot:snapshot,saveSnapshot,
      peekBody(item){if(!active()||!live(item))return;const row=rows.get(bodyKey(item));if(!row)return;try{return decode(row.value as string)}catch{remove(row.key);mirror()}},
      saveBody(item,bytes){if(!active()||!cachedDomains.has(item.domain)||!live(item))return;const value=encode(bytes);save({key:bodyKey(item),savedAt:nextStamp(),scope,owner,assistant,kind:'body',value,bytes:value.length*2})},
      forget(domain,key,revision){const current=snapshot();if(current)saveSnapshot({...current,revision,items:current.items.filter(item=>item.domain!==domain||item.resource_key!==key)})},
    }
  }
  function accountState<T>(owner:string,key:string,isValue:(value:unknown)=>value is T) {
    const scope=JSON.stringify([owner,'']),id=PREFIX+scope+':account:'+key
    const active=()=>!!owner&&input.accountId()===owner
    return {
      peek():T|undefined {const value=active()?rows.get(id)?.value:undefined;return isValue(value)?value:undefined},
      save(value:T){
        if(!active()||!isValue(value)||JSON.stringify(rows.get(id)?.value)===JSON.stringify(value))return
        save({key:id,savedAt:nextStamp(),scope,owner,assistant:'',kind:'account-state',value,bytes:JSON.stringify(value).length*2})
        input.changed()
      },
    }
  }
  return {files,accountState,ready,async flush(){await ready;await tail;clearTimeout(hotTimer);
    // Mirror writes are deliberately coalesced during a catalog's four-way fill.
    mirror();await new Promise(resolve=>setTimeout(resolve,30))},
  }
}
let shared:ReturnType<typeof createAssistantPanelCacheStore>|undefined
export function assistantPanelCacheStore(){return shared??=createAssistantPanelCacheStore({store:getAgentWatchStore,hot:()=>localStorage,accountId:()=>getRendererSession()?.user.id??null,
  changed:()=>window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED))})}
