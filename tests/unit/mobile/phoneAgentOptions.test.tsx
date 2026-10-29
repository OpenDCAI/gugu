// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { clickElement, createReactHarness } from '../../support/testHarness'
vi.mock('../../../apps/desktop/src/components/ui/Sheet', () => ({ Sheet: ({children}: {children: ReactNode}) => createElement('section', {role:'dialog'}, children) }))
import { CreateOptionsPill } from '../../../apps/desktop/src/mobile/agent-watch/CreateOptionsPill'
import { defaultSelection } from '../../../apps/desktop/src/mobile/agent-watch/create-session-form'

const options: SessionpageSessionCreateOptions = {
  projects:[{id:'private-project',name:'INTERNAL_PHONE_PROJECT',path:'/private'}],
  harnesses:[{id:'pi',name:'Pi',status:'available',watchable:true,sessionViews:['general'],permissionModes:[]}],lastUsed:null,
}
const models: SessionpageSessionCreateModels = {
  harness:'pi',transport:'acp',selected:null,selectedEffort:null,efforts:[],harnessState:'auth-required',harnessReason:null,guguReason:null,
  models:[{id:'platform:model-a',name:'Model A',source:'gugu'},{id:'legacy-own',name:'Internal Pi model',source:'harness'}],
}
const active: Array<ReturnType<typeof createReactHarness>>=[]
afterEach(()=>{for(const h of active.splice(0))h.cleanup()})
describe('phone Agent model options',()=>{
  it('shows Default while refreshing a known catalogue and loading only before that catalogue arrives',async()=>{
    const h=createReactHarness();active.push(h)
    const props={options,selection:defaultSelection(options),onChange:vi.fn(),busy:false,modelsState:'loading' as const}
    await h.render(createElement(CreateOptionsPill,{...props,models:null}))
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-open"]')!)
    const row=()=>h.container.querySelector('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')?.textContent??''
    expect(row()).toContain('正在问')
    await h.render(createElement(CreateOptionsPill,{...props,models}))
    expect(row()).toContain('默认');expect(row()).not.toContain('正在问')
    await h.render(createElement(CreateOptionsPill,{...props,models:{...models,harness:'codex'}}))
    expect(row()).toContain('正在问')
  })
  it('shows the fixed phone Agent identity and opens models directly without exposing an engine or private project',async()=>{
    const h=createReactHarness();active.push(h);const onChange=vi.fn(),selection=defaultSelection(options)
    await h.render(createElement(CreateOptionsPill,{options,selection,onChange,busy:false,models,modelsState:'ready',phoneHost:true}))
    const text=()=>h.container.textContent??''
    expect(text()).toContain('手机 Agent');expect(text()).not.toContain('Pi');expect(text()).not.toContain('INTERNAL_PHONE_PROJECT')
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-open"]')!)
    expect(h.container.querySelector('[data-dimension="model"][role="radiogroup"]')).not.toBeNull()
    expect(h.container.querySelector('[data-dimension="harness"]')).toBeNull()
    expect(h.container.querySelector('[data-dimension="project"]')).toBeNull()
    expect(text()).not.toContain('Pi');expect(text()).not.toContain('harness')
    await clickElement(h.container.querySelector<HTMLElement>('[data-option-id="platform:model-a"]')!)
    expect(onChange).toHaveBeenCalledExactlyOnceWith({...selection,harness:'pi',model:'platform:model-a'},true)
    expect(h.container.querySelector('[role="dialog"]')).not.toBeNull()
  })
  it('titles the permission sheet with its label, not the raw permission table',async()=>{
    const h=createReactHarness();active.push(h)
    const desktop: SessionpageSessionCreateOptions={...options,harnesses:[{...options.harnesses[0]!,permissionModes:['edit','full-access']}]}
    await h.render(createElement(CreateOptionsPill,{options:desktop,selection:defaultSelection(desktop),onChange:vi.fn(),busy:false,models,modelsState:'ready'}))
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-open"]')!)
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="permission"]')!)
    const title=h.container.querySelector('.gg-aw-sheet-title')?.textContent??''
    expect(title).toContain('权限档');expect(title).not.toMatch(/object|agentWatch\./)
    expect(h.container.querySelector('[role="dialog"]')?.getAttribute('aria-label')??'').not.toMatch(/object|agentWatch\./)
  })
  it('keeps real computer engine selection available',async()=>{
    const h=createReactHarness();active.push(h);const onChange=vi.fn()
    const desktop={...options,harnesses:[...options.harnesses,{id:'codex',name:'Codex',status:'available' as const,watchable:true,sessionViews:['general' as const],permissionModes:[]}]}
    const selection={...defaultSelection(options)}
    await h.render(createElement(CreateOptionsPill,{options:desktop,selection,onChange,busy:false,models,modelsState:'ready'}))
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-open"]')!)
    await clickElement(h.container.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="harness"]')!)
    await clickElement(h.container.querySelector<HTMLElement>('[data-option-id="codex"]')!)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({harness:'codex'}))
  })
})
