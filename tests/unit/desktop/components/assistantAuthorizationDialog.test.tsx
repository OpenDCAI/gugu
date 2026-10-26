// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from 'vitest'
import type { ReactNode,ButtonHTMLAttributes } from 'react'
import { buildIntegrationListPayload } from '../../../../apps/desktop/electron/session/main/core/integrations/integration-payload-builder'
import type { LibraryHost } from '../../../../apps/desktop/src/session/renderer/features/library/library-host'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { assistantPanelLibraryHost } from '../../../../apps/desktop/src/components/assistant/assistant-panel-library-host'
import { createReactHarness,clickElement,deferred } from '../../../support/testHarness'

const fixture=vi.hoisted(()=>({host:null as unknown,metadata:null as unknown,context:null as unknown,online:false}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider',()=>({IntegrationsProvider:({children}:{children:ReactNode})=>children,useIntegrationsContext:()=>fixture.context}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({LibraryHostProvider:({children}:{children:ReactNode})=>children,useLibraryHost:()=>fixture.host}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store',()=>({remoteHostsStore:{device:()=>({isOnline:fixture.online})}}))
vi.mock('../../../../apps/desktop/src/components/assistant/useAssistantPanelIntegration',()=>({useAssistantPanelIntegration:()=>({data:fixture.metadata,error:null,loading:false})}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/dialog',()=>({DialogHeader:({children}:{children:ReactNode})=><div>{children}</div>,DialogTitle:({children}:{children:ReactNode})=><h2>{children}</h2>,DialogContentArea:({children}:{children:ReactNode})=><div>{children}</div>,DialogFooter:({children}:{children:ReactNode})=><footer>{children}</footer>}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/confirm-button',()=>({ConfirmButton:({children,...props}:ButtonHTMLAttributes<HTMLButtonElement>)=><button {...props}>{children}</button>}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast',()=>({useToast:()=>({toast:vi.fn()})}))
import { IntegrationSetupModal } from '../../../../apps/desktop/src/session/renderer/features/integrations/integration-setup-modal'

beforeEach(()=>{fixture.online=false})
function setup(id:string,prepare=vi.fn(async()=>{})){
 const native=vi.fn(async()=>({success:true as const,connected:true as const}))
 const host=assistantPanelLibraryHost({key:'remote',remote:{deviceId:'cloud',deviceLabel:'云端',online:false},integrations:{connect:native,authorize:native,cliLoginStart:native,cancelAuthorization:vi.fn()},github:{}} as unknown as LibraryHost,
  {ownerId:'owner',assistantId:'assistant',assertCurrent:async()=>{}} as unknown as AssistantPanelFiles,prepare)
 fixture.host=host
 fixture.metadata=buildIntegrationListPayload('zh-CN').find(item=>item.id===id)
 fixture.context={integrationById:{[id]:fixture.metadata},startCliLogin:()=>host.integrations.cliLoginStart(id),waitCliLogin:vi.fn(),readCliProgress:async()=>null,cancelIntegrationAuthorization:()=>host.integrations.cancelAuthorization(id),authorizeIntegration:()=>host.integrations.authorize(id),connectIntegration:(_id:string,input:Record<string,string>)=>host.integrations.connect(id,input),isIntegrationMutating:()=>false}
 const success=vi.fn(),close=vi.fn(),h=createReactHarness()
 return {h,native,prepare,success,close,render:()=>h.render(<IntegrationSetupModal host={host} integration={id} onSuccess={success} onClose={close}/>)}
}
it.each(['feishu','dingtalk','wecom','tencent-meeting','notion'])('allows explicit %s authorization while asleep, preparing before the native action',async id=>{
 const pending=deferred<void>(),f=setup(id,vi.fn(()=>pending.promise))
 try{
  await f.render()
  const button=f.h.container.querySelector<HTMLButtonElement>('footer button:last-child')!
  expect(button.matches(':disabled')).toBe(false)
  expect(f.prepare).not.toHaveBeenCalled()
  await clickElement(button)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(f.native).not.toHaveBeenCalled()
  pending.resolve();await clickElement(f.h.container.querySelector('h2')!)
  expect(f.native).toHaveBeenCalledTimes(1)
  expect(f.success).toHaveBeenCalledTimes(1)
 }finally{pending.resolve();f.h.cleanup()}
})
it.each(['feishu','notion'])('shows one explanation when the authorization host cannot be prepared for %s',async id=>{
 const f=setup(id,vi.fn(async()=>{throw new Error('云端授权服务暂时不可用。')}))
 try{await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!);expect(f.h.container.querySelector('[role="alert"]')?.textContent).toBe('云端授权服务暂时不可用。');expect(f.native).not.toHaveBeenCalled();expect(f.h.container.querySelectorAll('[role="alert"]')).toHaveLength(1)}finally{f.h.cleanup()}
})
it('explains missing form fields instead of leaving a disabled submit button',async()=>{
 const f=setup('asana')
 try{await f.render();const button=f.h.container.querySelector<HTMLButtonElement>('footer button:last-child')!;expect(button.matches(':disabled')).toBe(false);await clickElement(button);expect(f.h.container.querySelector('[role="alert"]')?.textContent).toContain('个人访问令牌');expect(f.prepare).not.toHaveBeenCalled();expect(f.native).not.toHaveBeenCalled()}finally{f.h.cleanup()}
})
it.each(['feishu','notion'])('does not start %s authorization after the person closes the dialog during preparation',async id=>{
 const pending=deferred<void>(),f=setup(id,vi.fn(()=>pending.promise))
 try{await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!);await f.h.render(null);pending.resolve();await f.h.render(null);expect(f.native).not.toHaveBeenCalled();expect(f.success).not.toHaveBeenCalled()}finally{pending.resolve();f.h.cleanup()}
})
