// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from 'vitest'
import type { ReactNode,ButtonHTMLAttributes } from 'react'
import { buildIntegrationListPayload } from '../../../../apps/desktop/electron/session/main/core/integrations/integration-payload-builder'
import type { LibraryHost } from '../../../../apps/desktop/src/session/renderer/features/library/library-host'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { assistantPanelLibraryHost } from '../../../../apps/desktop/src/components/assistant/assistant-panel-library-host'
import type { ConnectionMetadataStore } from '../../../../apps/desktop/src/components/connections/connection-metadata'
import { connectionActionNoticeScope,reportConnectionActionFailure } from '../../../../apps/desktop/src/components/connections/connection-action-notice'
import { prepareThenStartCliLogin } from '../../../../apps/desktop/src/session/renderer/features/integrations/cli-tool-prepare'
import { ownerConnectionActions } from '../../../../apps/desktop/src/components/connections/owner-connection-actions'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import type { ConnectionClient } from '@gugu/core/cloud/connections'
import { createReactHarness,clickElement,deferred,typeInto } from '../../../support/testHarness'

const fixture=vi.hoisted(()=>({host:null as unknown,metadata:null as unknown,context:null as unknown,online:false,notice:vi.fn(),bridge:{} as Record<string,unknown>}))
vi.mock('@/lib/notices',()=>({notify:fixture.notice}))
vi.mock('@/lib/connectionBridge',()=>({connectionBridge:()=>fixture.bridge}))
vi.mock('@/lib/platformIntegrations',()=>({rendererPlatformIntegrationsClient:()=>({})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider',()=>({IntegrationsProvider:({children}:{children:ReactNode})=>children,useIntegrationsContext:()=>fixture.context}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({LibraryHostProvider:({children}:{children:ReactNode})=>children,useLibraryHost:()=>fixture.host}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store',()=>({remoteHostsStore:{device:()=>({isOnline:fixture.online})}}))
vi.mock('../../../../apps/desktop/src/components/assistant/useAssistantPanelIntegration',()=>({useAssistantPanelIntegration:()=>({data:fixture.metadata,error:null,loading:false})}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/dialog',()=>({DialogHeader:({children}:{children:ReactNode})=><div>{children}</div>,DialogTitle:({children}:{children:ReactNode})=><h2>{children}</h2>,DialogContentArea:({children}:{children:ReactNode})=><div>{children}</div>,DialogFooter:({children}:{children:ReactNode})=><footer>{children}</footer>}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ui/confirm-button',()=>({ConfirmButton:({children,...props}:ButtonHTMLAttributes<HTMLButtonElement>)=><button {...props}>{children}</button>}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast',()=>({useToast:()=>({toast:vi.fn()})}))
import { IntegrationSetupModal } from '../../../../apps/desktop/src/session/renderer/features/integrations/integration-setup-modal'

beforeEach(()=>{fixture.online=false;fixture.notice.mockClear()})
function setup(id:string,prepare=vi.fn(async()=>{})){
 const native=vi.fn(async()=>({success:true as const,connected:true as const}))
 const host=assistantPanelLibraryHost({key:'remote',remote:{deviceId:'cloud',deviceLabel:'云端',online:false},integrations:{connect:native,authorize:native,cliLoginStart:native,cancelAuthorization:vi.fn(),checkConfiguredConnections:async()=>({})},github:{}} as unknown as LibraryHost,
  {ownerId:'owner',assistantId:'assistant',assertCurrent:async()=>{}} as unknown as AssistantPanelFiles,prepare)
 fixture.host=host
 fixture.metadata=buildIntegrationListPayload('zh-CN').find(item=>item.id===id)
 fixture.context={integrationById:{[id]:fixture.metadata},startCliLogin:()=>host.integrations.cliLoginStart(id),waitCliLogin:vi.fn(),readCliProgress:async()=>null,cancelIntegrationAuthorization:()=>host.integrations.cancelAuthorization(id),authorizeIntegration:()=>host.integrations.authorize(id),connectIntegration:(_id:string,input:Record<string,string>)=>host.integrations.connect(id,input),isIntegrationMutating:()=>false}
 const success=vi.fn(),close=vi.fn(),h=createReactHarness()
 return {h,host,native,prepare,success,close,render:()=>h.render(<IntegrationSetupModal host={host} integration={id} onSuccess={success} onClose={close}/>)}
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
it('cancels a pending protocol-2 form on window close and ignores its late success without a notification',async()=>{
 const f=setup('asana'),pending=deferred<{success:true}>(),cancel=vi.fn()
 f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner',verificationProtocol:2} as ConnectionMetadataStore
 const context=fixture.context as {connectIntegration:()=>Promise<unknown>;cancelIntegrationAuthorization:()=>void}
 context.connectIntegration=()=>pending.promise;context.cancelIntegrationAuthorization=cancel
 try{
  await f.render();await typeInto(f.h.container.querySelector('input')!,'synthetic')
  await clickElement(f.h.container.querySelector('footer button:last-child')!)
  await f.h.render(null);expect(cancel).toHaveBeenCalledExactlyOnceWith('asana')
  pending.resolve({success:true});await f.h.render(null)
  expect(f.success).not.toHaveBeenCalled();expect(fixture.notice).not.toHaveBeenCalled()
 }finally{pending.resolve({success:true});f.h.cleanup()}
})
it.each(['feishu','notion'])('does not start %s authorization after the person closes the dialog during preparation',async id=>{
 const pending=deferred<void>(),f=setup(id,vi.fn(()=>pending.promise))
 try{await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!);await f.h.render(null);pending.resolve();await f.h.render(null);expect(f.native).not.toHaveBeenCalled();expect(f.success).not.toHaveBeenCalled()}finally{pending.resolve();f.h.cleanup()}
})

it.each(['result','exception'] as const)('reports an owner CLI preparation %s failure through the unified notice before hiding the inline error',async kind=>{
 const f=setup('feishu'),prepare=vi.fn(async()=>{if(kind==='exception')throw Object.assign(new Error('internal install diagnostic'),{code:'forbidden'});return {status:'failed' as const,error:'internal install diagnostic'}}),login=vi.fn()
 f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner'} as ConnectionMetadataStore
 ;(fixture.context as {startCliLogin:()=>Promise<unknown>}).startCliLogin=()=>prepareThenStartCliLogin({cliToolPrepare:prepare,cliLoginStart:login},'feishu')
 try{
  await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!)
  expect(prepare).toHaveBeenCalledOnce();expect(login).not.toHaveBeenCalled()
  expect(fixture.notice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({tier:'error',title:'飞书的授权工具没准备好，请稍后重新连接。'}))
  expect(f.h.container.querySelector('[role="alert"]')).toBeNull()
  expect(f.h.container.textContent).not.toContain('internal install diagnostic')
 }finally{f.h.cleanup()}
})

it.each(['result','error'] as const)('does not duplicate a failed CLI %s notice already reported by its action wrapper',async kind=>{
 const f=setup('feishu'),result={success:false as const,error:'internal service detail'}
 f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner'} as ConnectionMetadataStore
 ;(fixture.context as {startCliLogin:()=>Promise<unknown>}).startCliLogin=async()=>{
  if(kind==='result'){
   reportConnectionActionFailure(result,{ownerId:'owner',provider:'feishu',title:'飞书没连上，请重新授权。',after:connectionActionNoticeScope()})
   return result
  }
  const original=new Error('internal'),forwarded=new Error('safe forwarded failure')
  reportConnectionActionFailure(original,{ownerId:'owner',provider:'feishu',title:'飞书没连上，请重新授权。',after:connectionActionNoticeScope()},forwarded)
  throw forwarded
 }
 try{
  await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!)
  expect(fixture.notice).toHaveBeenCalledTimes(1)
  await clickElement(f.h.container.querySelector('footer button:last-child')!)
  expect(fixture.notice).toHaveBeenCalledTimes(2)
  expect(f.h.container.querySelector('[role="alert"]')).toBeNull()
 }finally{f.h.cleanup()}
})
it('keeps a cancelled owner CLI preparation quiet and never starts login from its late result',async()=>{
 const f=setup('feishu'),pending=deferred<{status:'ready'}>(),login=vi.fn();let cancelled=false
 f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner'} as ConnectionMetadataStore
 const context=fixture.context as {startCliLogin:()=>Promise<unknown>;cancelIntegrationAuthorization:()=>void}
 context.startCliLogin=async()=>await prepareThenStartCliLogin({cliToolPrepare:()=>pending.promise,cliLoginStart:login},'feishu',{cancelled:()=>cancelled}) ?? {success:false,error:'cancelled',cancelled:true}
 context.cancelIntegrationAuthorization=()=>{cancelled=true}
 try{
  await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!)
  await f.h.render(null);pending.resolve({status:'ready'});await f.h.render(null)
  expect(login).not.toHaveBeenCalled();expect(fixture.notice).not.toHaveBeenCalled()
 }finally{pending.resolve({status:'ready'});f.h.cleanup()}
})
it('closes a blocked owner CLI dialog quietly instead of offering a new authorization',async()=>{
 const f=setup('feishu');f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner'} as ConnectionMetadataStore
 ;(fixture.context as {startCliLogin:()=>Promise<unknown>}).startCliLogin=async()=>{throw Object.assign(new Error('blocked'),{code:'outcome-unknown'})}
 try{
  await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!)
  expect(f.close).toHaveBeenCalledOnce();expect(fixture.notice).not.toHaveBeenCalled();expect(f.native).not.toHaveBeenCalled()
 }finally{f.h.cleanup()}
})

it.each(['AbortError','cancelled','failure'] as const)('preserves %s classification through owner actions and CLI orchestration while the dialog remains mounted',async kind=>{
 const f=setup('feishu'),route:ConnectionRoute={mode:'owner',epoch:'1',phase:'stable',acceptingNewOperations:true}
 const failure=kind==='AbortError'?new DOMException('User cancelled','AbortError'):Object.assign(new Error('synthetic action failure'),kind==='cancelled'?{cancelled:true}:{})
 const prepare=vi.fn(async()=>({status:'ready' as const})),login=vi.fn(async()=>{throw failure})
 const client={snapshot:async()=>({version:1,state:'ready',revision:'0',items:[],application:[]}),recreateBegin:vi.fn(async()=>({recreationId:'e8939ca7-ef3e-4474-a71c-76eb993b0a17',operationId:'6c67af58-7190-4c6f-9d49-06d0f6f4865f',expectedItemRevision:null,revision:'0',expiresAt:'2099-01-01T00:00:00Z'}))} as unknown as ConnectionClient
 fixture.bridge={accountId:()=> 'owner',client,routing:createConnectionRouting({accountId:()=> 'owner',read:async()=>route,changed:()=>{}})}
 f.host.connectionMetadataExpected=true;f.host.connectionMetadata={ownerId:'owner',invalidate:vi.fn()} as unknown as ConnectionMetadataStore
 const base={...f.host,integrations:{...f.host.integrations,cliToolPrepare:prepare,cliLoginStart:login,ownerAuthorizationBegin:vi.fn(async()=>{}),ownerAuthorizationComplete:vi.fn(async()=>{}),ownerAccounts:vi.fn(async()=>[]),ownerAuthorizationCommit:vi.fn()}}
 const actions=ownerConnectionActions(base,base,'cloud',route)
 fixture.host=actions
 ;(fixture.context as {startCliLogin:()=>Promise<unknown>}).startCliLogin=()=>prepareThenStartCliLogin(actions.integrations,'feishu')
 try{
  await f.render();await clickElement(f.h.container.querySelector('footer button:last-child')!)
  expect(prepare).toHaveBeenCalledOnce();expect(login).toHaveBeenCalledOnce();expect(client.recreateBegin).toHaveBeenCalledOnce()
  expect(f.h.container.querySelector('h2')).not.toBeNull();expect(f.success).not.toHaveBeenCalled()
  if(kind==='failure'){
   expect(fixture.notice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({tier:'error',title:expect.stringContaining('飞书')}))
   expect(f.close).not.toHaveBeenCalled()
  }else{
   expect(fixture.notice).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce()
  }
 }finally{f.h.cleanup()}
})
