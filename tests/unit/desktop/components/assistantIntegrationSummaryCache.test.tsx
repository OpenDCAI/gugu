// @vitest-environment jsdom
import { expect,it,vi } from 'vitest'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { IntegrationMetadata } from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import { useAssistantIntegrationSummaries } from '../../../../apps/desktop/src/components/assistant/useAssistantIntegrationSummaries'

it('keeps localized names and descriptions across fresh list arrays without another body read',async()=>{
 const h=createReactHarness(),renders:string[]=[]
 const body=vi.fn(async()=>new TextEncoder().encode(JSON.stringify({version:1,en:{id:'mail',name:'Mailbox',description:'English summary',auth:{methods:[]}},'zh-CN':{id:'mail',name:'邮箱',description:'中文说明',auth:{methods:[]}}})))
 const panel={ownerId:'cache-owner',assistantId:'cache-assistant',collection:async()=>[{resource_key:'catalog:mail',data:{providerId:'mail'}}],body} as unknown as AssistantPanelFiles
 const items=()=>[{id:'mail',name:'mail',description:'',metadataOnly:true}] as IntegrationMetadata[]
 function Probe({rows,locale}:{rows:IntegrationMetadata[];locale:string}){const value=useAssistantIntegrationSummaries(panel,rows,locale);const text=`${value[0]!.name}|${value[0]!.description}`;renders.push(text);return <span>{text}</span>}
 try{
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(h.container.textContent).toBe('Mailbox|English summary')
  const first=renders.length
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(renders.slice(first)).not.toContain('mail|')
  expect(h.container.textContent).toBe('Mailbox|English summary')
  expect(body).toHaveBeenCalledTimes(1)
  await h.render(<Probe rows={items()} locale="zh-CN"/> )
  expect(h.container.textContent).toBe('邮箱|中文说明')
  expect(body).toHaveBeenCalledTimes(2)
  const beforeEnglish=renders.length
  await h.render(<Probe rows={items()} locale="en-US"/> )
  expect(renders.slice(beforeEnglish).every(text=>text==='Mailbox|English summary')).toBe(true)
  expect(body).toHaveBeenCalledTimes(2)
 }finally{h.cleanup()}
})

it('shares in-flight enrichment across list refreshes, keeps it after remount, and scopes it to the account',async () => {
 const h=createReactHarness(),pending=Promise.withResolvers<Uint8Array>()
 const body=vi.fn(()=>pending.promise)
 const panel={ownerId:'pending-owner',assistantId:'assistant',collection:async()=>[{resource_key:'catalog:mail',data:{providerId:'mail'}}],body} as unknown as AssistantPanelFiles
 const rows=()=>[{id:'mail',name:'mail',description:'',metadataOnly:true}] as IntegrationMetadata[]
 function Probe({current=panel}:{current?:AssistantPanelFiles}){const value=useAssistantIntegrationSummaries(current,rows(),'en-US');return <span>{value[0]!.name}|{value[0]!.description}</span>}
 try {
  await h.render(<Probe/>); await h.render(<Probe/>)
  expect(body).toHaveBeenCalledTimes(1)
  await act(async()=>pending.resolve(new TextEncoder().encode(JSON.stringify({version:1,en:{id:'mail',name:'Mailbox',description:'Cached',auth:{methods:[]}}}))))
  expect(h.container.textContent).toBe('Mailbox|Cached')
  await h.render(null); await h.render(<Probe current={{...panel} as AssistantPanelFiles}/> )
  expect(h.container.textContent).toBe('Mailbox|Cached')
  expect(body).toHaveBeenCalledTimes(1)
  await h.render(<Probe current={{...panel,ownerId:'another-owner',body:async()=>{throw new Error('unavailable')}} as AssistantPanelFiles}/> )
  expect(h.container.textContent).toBe('mail|')
 } finally { h.cleanup() }
})
