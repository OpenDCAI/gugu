// @vitest-environment jsdom
import { expect,it,vi } from 'vitest'
import type { AssistantPanelItem,AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { createAssistantPanelCacheStore } from '@/components/assistant/assistant-panel-cache'
import type { AgentWatchLocalStore,LocalRow } from '@/session/shared/remote-sessions/local-store'
const item:AssistantPanelItem={assistant_user_id:'assistant',owner_user_id:'owner',domain:'integrations',resource_key:'catalog:mail',device_id:'home',revision:'1',data:{providerId:'mail',configured:false,displayName:'邮箱'},body_item_id:'body',body_sha256:'a'.repeat(64),deleted_at:null,observed_at:null,updated_at:'2026-10-27'}
const snapshot=(items=[item],revision='1'):AssistantPanelSnapshot=>({version:1,revision,items,application:[]})
function fixture(){
 let owner:string|null='owner';const durable=new Map<string,LocalRow>(),hot=new Map<string,string>()
 const store:AgentWatchLocalStore={readAll:async()=>[...durable.values()],read:async(_store,key)=>durable.get(key)??null,put:async(_store,row)=>{durable.set(row.key,structuredClone(row))},delete:async(_store,key)=>{durable.delete(key)},clear:async()=>{durable.clear()}}
 const deps={store:async()=>store,hot:()=>({getItem:(key:string)=>hot.get(key)??null,setItem:(key:string,value:string)=>{hot.set(key,value)}}),accountId:()=>owner,changed:vi.fn()}
 return {deps,hot,setOwner:(value:string|null)=>{owner=value},manager:()=>createAssistantPanelCacheStore(deps)}
}
it('shows saved catalog metadata and complete details synchronously across restart and offline account restoration',async()=>{
 const f=fixture(),first=f.manager();await first.ready;const cache=first.files('owner','assistant')
 cache.saveSnapshot(snapshot());cache.saveBody(item,new TextEncoder().encode('完整详情'));await first.flush()
 const restarted=f.manager(),copy=restarted.files('owner','assistant')
 expect(copy.peekSnapshot()?.items[0]?.data.displayName).toBe('邮箱')
 expect(new TextDecoder().decode(copy.peekBody(item))).toBe('完整详情')
 f.setOwner(null);expect(copy.peekSnapshot()).toBeUndefined();expect(copy.peekBody(item)).toBeUndefined()
 f.setOwner('other');expect(copy.peekSnapshot()).toBeUndefined();expect(restarted.files('other','assistant').peekSnapshot()).toBeUndefined()
 f.setOwner('owner');expect(copy.peekBody(item)).toBeDefined();await restarted.flush()
})
it('never restores deleted bodies from a late download, an older snapshot or disk hydration',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready;const cache=manager.files('owner','assistant')
 cache.saveSnapshot(snapshot());cache.saveBody(item,new TextEncoder().encode('old'))
 cache.forget('integrations',item.resource_key,'2');cache.saveBody(item,new TextEncoder().encode('late'));cache.saveSnapshot(snapshot())
 await manager.flush();const restarted=f.manager();await restarted.ready
 expect(restarted.files('owner','assistant').peekSnapshot()?.items).toEqual([])
 expect(restarted.files('owner','assistant').peekBody(item)).toBeUndefined();await restarted.flush()
})
it('retains all 21 previously read application details in the synchronous mirror',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready;const cache=manager.files('owner','assistant')
 const items=Array.from({length:21},(_,i)=>({...item,resource_key:`catalog:app-${i}`,body_item_id:`body-${i}`}))
 cache.saveSnapshot(snapshot(items));for(const row of items)cache.saveBody(row,new TextEncoder().encode(JSON.stringify({id:row.resource_key,auth:{methods:[{type:'oauth'}]}})))
 await manager.flush();const restarted=f.manager(),copy=restarted.files('owner','assistant')
 for(const row of items)expect(JSON.parse(new TextDecoder().decode(copy.peekBody(row))).id).toBe(row.resource_key)
 await restarted.flush()
})
it('treats damaged local metadata as absent rather than a successful empty collection',async()=>{
 const f=fixture();f.hot.set('gugu.assistantPanel.v1',JSON.stringify({version:1,rows:[{key:'assistant-panel.v1:bad',owner:'owner',assistant:'assistant',scope:'["owner","assistant"]',kind:'snapshot',savedAt:1,bytes:1,value:{items:[]}}]}))
 const manager=f.manager();expect(manager.files('owner','assistant').peekSnapshot()).toBeUndefined();await manager.flush()
})
it('exposes one local copy through the files API and warms details without blocking snapshot metadata',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready;const cache=manager.files('owner','assistant')
 const held=Promise.withResolvers<Uint8Array>(),readBody=vi.fn(()=>held.promise)
 const panel=createAssistantPanelFiles({ownerId:'owner',assistantId:'assistant',deviceId:'home',cache,assertCurrent:()=>{},changed:vi.fn(),
   cloud:{snapshot:async()=>snapshot()} as never,readBody,upload:vi.fn(),discard:vi.fn()})
 await panel.snapshot();expect(panel.peekSnapshot()?.items[0]?.resource_key).toBe(item.resource_key)
 expect(panel.peekBody(item)).toBeUndefined();held.resolve(new TextEncoder().encode('detail'));await panel.body(item)
 expect(new TextDecoder().decode(panel.peekBody(item))).toBe('detail');expect(readBody).toHaveBeenCalledOnce()
 f.setOwner('other');expect(panel.peekSnapshot()).toBeUndefined();expect(panel.peekBody(item)).toBeUndefined();await manager.flush()
})
it('keeps account application state in the same durable store and never exposes another account’s copy',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready
 const valid=(v:unknown):v is {channels:string[]}=>!!v&&typeof v==='object'&&Array.isArray((v as {channels:unknown}).channels)
 const state=manager.accountState('owner','wechat',valid);state.save({channels:['connected']});await manager.flush()
 const restarted=f.manager(),copy=restarted.accountState('owner','wechat',valid)
 expect(copy.peek()).toEqual({channels:['connected']})
 f.setOwner('other');expect(copy.peek()).toBeUndefined();copy.save({channels:['wrong-account']})
 expect(restarted.accountState('other','wechat',valid).peek()).toBeUndefined()
 f.setOwner('owner');expect(copy.peek()).toEqual({channels:['connected']});await restarted.flush()
})

it('keeps an unopened application list free of catalog body downloads, then refreshes only a previously opened detail',async()=>{
 const f=fixture(),manager=f.manager();await manager.ready;const cache=manager.files('owner','assistant')
 let current=snapshot();const readBody=vi.fn(async()=>new TextEncoder().encode('detail'))
 const panel=createAssistantPanelFiles({ownerId:'owner',assistantId:'assistant',deviceId:'home',cache,assertCurrent:()=>{},changed:vi.fn(),
   cloud:{snapshot:async()=>current} as never,readBody,upload:vi.fn(),discard:vi.fn()})
 await panel.snapshot();await new Promise(resolve=>setTimeout(resolve,30));expect(readBody).not.toHaveBeenCalled()
 await panel.body(item);expect(readBody).toHaveBeenCalledOnce()
 const next={...item,revision:'2',body_item_id:'body-new',body_sha256:'b'.repeat(64)};current=snapshot([next],'2')
 panel.invalidate();await vi.waitFor(()=>expect(readBody).toHaveBeenCalledTimes(2))
 expect(new TextDecoder().decode(panel.peekBody(next))).toBe('detail');await manager.flush()
})
