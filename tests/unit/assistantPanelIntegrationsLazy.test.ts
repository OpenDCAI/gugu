import { expect,it,vi } from 'vitest'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelIntegrations } from '../../apps/desktop/src/components/assistant/assistant-panel-integrations'
it.each([
  { displayName: 'default', metadata: undefined, expected: undefined },
  { displayName: 'default', metadata: { login: 'ada@example.com' }, expected: 'ada@example.com' },
  { displayName: 'default', metadata: { displayName: '研究团队' }, expected: '研究团队' },
  { displayName: ' Ada ', metadata: undefined, expected: 'Ada' },
])('keeps account identity separate from legacy credential labels: $expected', async ({ displayName, metadata, expected }) => {
  const rows = [
    { resource_key: 'catalog:dingtalk', data: { providerId: 'dingtalk' } },
    { resource_key: 'account', observed_at: '2026-10-26', data: { providerId: 'dingtalk', accountId: 'default', configured: true, checkResult: 'ok', checkedAt: 50, displayName, publicMetadata: metadata } },
  ]
  const panel = { collection: async () => rows, snapshot: async () => ({ application: [] }) } as unknown as AssistantPanelFiles
  expect((await readAssistantPanelIntegrations(panel, 'zh-CN')).statuses.dingtalk?.displayName).toBe(expected)
})
it('shows all catalog names and account states without downloading any body',async () => {
  const body=vi.fn(async () => { throw new Error('one unavailable body') })
  const rows=Array.from({ length:21 },(_,i)=>({ resource_key:`catalog:p${i}`,data:{providerId:`p${i}`,displayName:`App ${i}`} }))
  const account={ resource_key:'account',observed_at:'2026-10-26',data:{providerId:'p0',accountId:'a',configured:true,checkResult:'ok',checkedAt:50} }
  const panel={collection:async()=>[...rows,account],snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
  const result=await readAssistantPanelIntegrations(panel,'en-US')
  expect(result.items).toHaveLength(21)
  expect(result.items[0]).toMatchObject({id:'p0',name:'App 0'})
  expect(result.statuses.p0).toMatchObject({connected:true})
  expect(body).not.toHaveBeenCalled()
})

it('downloads only the selected application body, and a failed detail leaves the list usable',async () => {
  const { readAssistantPanelIntegration }=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
  const rows=['one','two'].map(id=>({resource_key:`catalog:${id}`,data:{providerId:id,displayName:id}}))
  const body=vi.fn(async (row:typeof rows[number])=>{
    if(row.data.providerId==='one')throw new TypeError('Failed to fetch')
    return new TextEncoder().encode(JSON.stringify({version:1,'zh-CN':{id:'two',name:'Second app',auth:{methods:[]}}}))
  })
  const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
  await expect(readAssistantPanelIntegration(panel,'one','zh-CN')).rejects.toThrow('Failed to fetch')
  expect(body).toHaveBeenCalledTimes(1)
  expect((await readAssistantPanelIntegrations(panel,'zh-CN')).items).toHaveLength(2)
  expect(body).toHaveBeenCalledTimes(1)
  expect(await readAssistantPanelIntegration(panel,'two','zh-CN')).toMatchObject({id:'two',name:'Second app'})
  expect(body).toHaveBeenCalledTimes(2)
})

it('uses built-in localized copy and icons without downloading bodies',async()=>{
 const {integrationIcons}=await import('@gugu/session-plugins/integration-icons')
 const body=vi.fn()
 const panel={collection:async()=>[{resource_key:'catalog:github',data:{providerId:'github',displayName:'GitHub',description:'Saved description'}}],snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
 const result=await readAssistantPanelIntegrations(panel,'en-US')
 expect(result.items[0]!.icon).toEqual(integrationIcons.github)
 expect(result.items[0]!.description).toBe('Work on GitHub issues and PRs')
 expect(body).not.toHaveBeenCalled()
})
it('fills optional descriptions one by one with four workers and ignores a broken description',async()=>{
 const {enrichAssistantPanelIntegrations}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const rows=Array.from({length:9},(_,i)=>({resource_key:`catalog:p${i}`,data:{providerId:`p${i}`,displayName:`App ${i}`}}))
 let active=0,peak=0
 const body=vi.fn(async(row:typeof rows[number])=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;if(row.data.providerId==='p0')throw Error('unreadable');return new TextEncoder().encode(JSON.stringify({version:1,en:{id:row.data.providerId,name:row.data.providerId,description:`Description ${row.data.providerId}`,auth:{methods:[]}}}))})
 const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
 const items=(await readAssistantPanelIntegrations(panel,'en-US')).items,updated=vi.fn()
 expect(body).not.toHaveBeenCalled()
 await enrichAssistantPanelIntegrations(panel,items,'en-US',updated)
 expect(peak).toBe(4)
 expect(updated).toHaveBeenCalledTimes(8)
 expect(updated).not.toHaveBeenCalledWith('p0',expect.anything())
 expect(updated).toHaveBeenCalledWith('p8',{name:'App 8',description:'Description p8'})
 expect(items).toHaveLength(9)
})

it('fills a legacy catalog name even when its description is already present',async()=>{
 const {enrichAssistantPanelIntegrations}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const rows=[{resource_key:'catalog:custom-mail',data:{providerId:'custom-mail',description:'Saved description'}}]
 const body=vi.fn(async()=>new TextEncoder().encode(JSON.stringify({version:1,'zh-CN':{id:'custom-mail',name:'公司邮箱',auth:{methods:[]}}})))
 const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
 const items=(await readAssistantPanelIntegrations(panel,'zh-CN')).items,updated=vi.fn()
 expect(body).not.toHaveBeenCalled()
 await enrichAssistantPanelIntegrations(panel,items,'zh-CN',updated)
 expect(body).toHaveBeenCalledTimes(1)
 expect(updated).toHaveBeenCalledWith('custom-mail',{name:'公司邮箱',description:'Saved description'})
})

it('treats a malformed unknown description as only that entry being unreadable',async()=>{
 const {enrichAssistantPanelIntegrations}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const rows=[{resource_key:'catalog:custom',data:{providerId:'custom',displayName:'Company app'}}]
 const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body:async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'custom',name:'Company app',description:{bad:true},auth:{methods:[]}}}))} as unknown as AssistantPanelFiles
 const items=(await readAssistantPanelIntegrations(panel,'en-US')).items,updated=vi.fn()
 await enrichAssistantPanelIntegrations(panel,items,'en-US',updated)
 expect(updated).not.toHaveBeenCalled()
 expect(items[0]!.name).toBe('Company app')
})

it('renders built-in localized names and descriptions even if every first body download fails',async () => {
 const rows=['feishu','dingtalk','wecom','tencent-docs','tencent-meeting','dida'].map(id=>({resource_key:`catalog:${id}`,data:{providerId:id,displayName:id}}))
 const body=vi.fn(async()=>{throw new TypeError('download unavailable')})
 const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body} as unknown as AssistantPanelFiles
 const zh=await readAssistantPanelIntegrations(panel,'zh-CN')
 expect(zh.items.map(item=>item.name)).toEqual(['飞书','钉钉','企业微信','腾讯文档','腾讯会议','滴答清单'])
 expect(zh.items.every(item=>!!item.description)).toBe(true)
 const en=await readAssistantPanelIntegrations(panel,'en-US')
 expect(en.items.map(item=>item.name)).toEqual(['Feishu','DingTalk','WeCom','Tencent Docs','Tencent Meeting','Dida365'])
 expect(en.items.every(item=>!!item.description)).toBe(true)
 const {enrichAssistantPanelIntegrations}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 await enrichAssistantPanelIntegrations(panel,zh.items,'zh-CN',vi.fn())
 expect(body).not.toHaveBeenCalled()
})

it('keeps an unknown catalog display name and never uses its id as a name after enrichment fails',async()=>{
 const rows=[{resource_key:'catalog:custom',data:{providerId:'custom',displayName:'Company app'}},{resource_key:'catalog:unnamed',data:{providerId:'unnamed',displayName:'unnamed'}}]
 const panel={collection:async()=>rows,snapshot:async()=>({application:[]}),body:async()=>{throw new TypeError('download unavailable')}} as unknown as AssistantPanelFiles
 const result=await readAssistantPanelIntegrations(panel,'zh-CN')
 expect(result.items.map(item=>item.name)).toEqual(['Company app','应用'])
 const {enrichAssistantPanelIntegrations}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const updated=vi.fn()
 await enrichAssistantPanelIntegrations(panel,result.items,'zh-CN',updated)
 expect(updated).not.toHaveBeenCalled()
 expect(result.items.every(item=>item.name!==item.id)).toBe(true)
})


it('shares selected metadata reads and invalidates only a changed content version or locale',async () => {
 const {readAssistantPanelIntegration,cachedAssistantPanelIntegration}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 let version='one'
 const collection=vi.fn(async()=>[{resource_key:'catalog:custom',body_sha256:version,data:{providerId:'custom'}}])
 const body=vi.fn(async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'custom',name:'Company app',auth:{methods:[]}},'zh-CN':{id:'custom',name:'公司应用',auth:{methods:[]}}})))
 const panel={collection,body} as unknown as AssistantPanelFiles
 await Promise.all([readAssistantPanelIntegration(panel,'custom','en-US','one'),readAssistantPanelIntegration(panel,'custom','en-US','one')])
 expect(body).toHaveBeenCalledTimes(1)
 expect(cachedAssistantPanelIntegration(panel,'custom','en-US','one')?.name).toBe('Company app')
 const reads=collection.mock.calls.length
 await readAssistantPanelIntegration(panel,'custom','en-US','one')
 expect(collection).toHaveBeenCalledTimes(reads)
 version='two'
 expect(cachedAssistantPanelIntegration(panel,'custom','en-US','two')).toBeUndefined()
 await readAssistantPanelIntegration(panel,'custom','en-US','two')
 await readAssistantPanelIntegration(panel,'custom','zh-CN','two')
 expect(body).toHaveBeenCalledTimes(3)
 expect(cachedAssistantPanelIntegration({...panel} as AssistantPanelFiles,'custom','en-US','two')).toBeUndefined()
})


it('parses an existing local catalog, account state and selected body synchronously with no network calls',async()=>{
 const {peekAssistantPanelIntegrations,peekAssistantPanelIntegration}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const row={domain:'integrations',device_id:'device',resource_key:'catalog:custom',body_sha256:'v1',data:{providerId:'custom',displayName:'Company app'}}
 const account={domain:'integrations',device_id:'device',resource_key:'a',observed_at:'2026-10-27',data:{providerId:'custom',accountId:'a',configured:true,checkResult:'ok',checkedAt:50}}
 const snapshot={version:1,revision:'1',items:[row,account,{domain:'integrations',device_id:'device',resource_key:'__collection__:device',data:{state:'ready'}}],application:[]}
 const bytes=new TextEncoder().encode(JSON.stringify({version:1,en:{id:'custom',name:'Company app',description:'Manage documents',auth:{methods:[]}}}))
 const network=vi.fn(async()=>{throw Error('offline')})
 const panel={deviceId:'device',peekSnapshot:()=>snapshot,peekBody:()=>bytes,collection:network,body:network} as unknown as AssistantPanelFiles
 expect(peekAssistantPanelIntegrations(panel,'en-US')?.configured.custom).toBe(true)
 expect(peekAssistantPanelIntegrations(panel,'en-US')?.statuses.custom?.connected).toBe(true)
 expect(peekAssistantPanelIntegration(panel,'custom','en-US')?.description).toBe('Manage documents')
 expect(network).not.toHaveBeenCalled()
 expect(peekAssistantPanelIntegration({...panel,peekBody:()=>undefined} as AssistantPanelFiles,'custom','en-US')).toBeUndefined()
})

it('reads a valid published catalog after a collection publication error without accepting rejected account changes',async()=>{
 const {readAssistantPanelIntegration}=await import('../../apps/desktop/src/components/assistant/assistant-panel-integrations')
 const row={domain:'integrations',device_id:'device',resource_key:'catalog:custom',body_sha256:'v1',data:{providerId:'custom',displayName:'Company app'}}
 const account={domain:'integrations',device_id:'device',resource_key:'account',observed_at:'2026-10-27',data:{providerId:'custom',configured:true,checkResult:'ok',checkedAt:50}}
 const snapshot={version:1,revision:'1',items:[row,account,{domain:'integrations',device_id:'device',resource_key:'__collection__:device',data:{state:'error'}}],application:[{domain:'integrations',resourceKey:'account',status:'failed'}]}
 const body=vi.fn(async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'custom',name:'Company app',auth:{methods:[]}}})))
 const panel={deviceId:'device',collection:async()=>{throw Error('collection failed')},snapshot:async()=>snapshot,peekSnapshot:()=>snapshot,body} as unknown as AssistantPanelFiles
 expect((await readAssistantPanelIntegrations(panel,'en-US')).statuses.custom).toBeUndefined()
 expect(await readAssistantPanelIntegration(panel,'custom','en-US')).toMatchObject({name:'Company app'})
 expect(body).toHaveBeenCalledOnce()
 row.body_sha256='v2';Object.assign(row,{stale_at:'2026-10-27'})
 await expect(readAssistantPanelIntegration(panel,'custom','en-US','v2')).rejects.toMatchObject({code:'stale'})
 Object.assign(row,{stale_at:null});snapshot.application.push({domain:'integrations',resourceKey:'catalog:custom',status:'failed'})
 await expect(readAssistantPanelIntegration(panel,'custom','en-US','v2')).rejects.toMatchObject({code:'application-failed'})
 expect(body).toHaveBeenCalledOnce()
})
