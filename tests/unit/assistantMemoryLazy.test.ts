import { expect,it,vi } from 'vitest'
import { readMemoryNotes,type AssistantMachine } from '../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
it('returns memory names and categories from metadata without waiting for bodies or the index',async () => {
  const text=vi.fn(async()=>null)
  const panel={collection:async()=>[
    {resource_key:'owner-profile.md',revision:'1',updated_at:'2026-10-26',data:{relativePath:'owner-profile.md',title:'About you',kind:'user'}},
    {resource_key:'other.md',revision:'2',updated_at:'2026-10-26',data:{relativePath:'other.md',title:'A reference',kind:'reference'}},
  ],list:async()=>['owner-profile.md','other.md'].map(name=>({name,path:`记忆/${name}`,type:'file',modifiedAt:new Date(0)})),text}
  const machine={deviceId:'home',paths:{memoryDir:'记忆',memoryIndex:'记忆/MEMORY.md'},panel} as unknown as AssistantMachine
  const result=await readMemoryNotes(machine)
  expect(result.notes).toMatchObject([{title:'About you',kind:'user',contentPending:true},{title:'A reference',contentPending:true}])
  expect(text).not.toHaveBeenCalled()
})
