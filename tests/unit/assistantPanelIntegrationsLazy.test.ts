import { expect,it,vi } from 'vitest'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelIntegrations } from '../../apps/desktop/src/components/assistant/assistant-panel-integrations'
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
