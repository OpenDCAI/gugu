// @vitest-environment jsdom
import { expect,it,vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { AssistantMemoryContent } from '../../../../apps/desktop/src/components/assistant/AssistantMemoryContent'
import type { AssistantMachine,MemoryEntry } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core'
const read=vi.hoisted(()=>vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-machine-core',()=>({readMemoryEntry:read}))
it('keeps both metadata cards visible when one body fails and renders the other body',async()=>{
  const h=createReactHarness()
  try {
    read.mockImplementation(async (_machine,entry:MemoryEntry)=>{if(entry.file==='one.md')throw new TypeError('network');return{...entry,body:'actual remembered fact'}})
    const machine={deviceId:'d',projectId:'p',workspaceId:'w',paths:{memoryDir:'记忆'}} as AssistantMachine
    const entries=['one','two'].map(id=>({file:`${id}.md`,title:id,path:`记忆/${id}.md`,kind:'reference',description:'internal instructions',body:'',modifiedAt:null,contentPending:true})) as MemoryEntry[]
    await h.render(<>{entries.map(entry=><AssistantMemoryContent key={entry.file} machine={machine} entry={entry}>{(current,error)=><p>{current.title}: {error?'unreadable':current.body}</p>}</AssistantMemoryContent>)}</>)
    expect(h.container.textContent).toContain('one: unreadable')
    expect(h.container.textContent).toContain('two: actual remembered fact')
    expect(h.container.textContent).not.toContain('internal instructions')
  }finally{h.cleanup()}
})
