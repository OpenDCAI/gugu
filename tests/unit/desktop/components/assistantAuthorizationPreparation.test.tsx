// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from 'vitest'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import type { LibraryHost } from '../../../../apps/desktop/src/session/renderer/features/library/library-host'
import { CloudComputerWakeError } from '@gugu/core/cloud/cloudComputer'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const fixture=vi.hoisted(()=>({wake:vi.fn(),start:vi.fn(),reconnect:vi.fn(),prepare:vi.fn(async()=>({status:'ready'}))}))
vi.mock('@/lib/cloudComputerStore',()=>({wakeAndWaitOnline:fixture.wake}))
vi.mock('@/lib/listDevicesOnceIdentified',()=>({listDevicesOnceIdentified:vi.fn(async()=>[])}))
vi.mock('@/lib/assistantPanelBridge',()=>({useAssistantPanelAccountId:()=> 'owner',requireAssistantPanelBridge:vi.fn()}))
vi.mock('@/components/assistant/assistant-panel-files',()=>({ASSISTANT_PANEL_CHANGED:'panel-changed',useCloudAssistantFiles:()=>({panel:{ownerId:'owner',assistantId:'assistant',assertCurrent:async()=>{}}})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell',()=>({useAssistantShell:()=>({assistant:{id:'assistant'},chatId:'dm'})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({createRemoteLibraryHost:(info:unknown)=>({key:'remote',remote:info,integrations:{cliToolPrepare:fixture.prepare,checkConfiguredConnections:async()=>({})},github:{}}),LibraryHostProvider:({children}:{children:unknown})=>children,LOCAL_LIBRARY_HOST:{},useLibraryHost:vi.fn()}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider',()=>({IntegrationsProvider:({children}:{children:unknown})=>children,useIntegrationsContext:vi.fn()}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store',()=>({remoteHostsStore:{device:()=>({isOnline:false}),start:fixture.start,reconnect:fixture.reconnect,connectionState:()=> 'connected'}}))
import { useHomeLibraryHost } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-integrations'
beforeEach(()=>{fixture.wake.mockReset();fixture.start.mockClear();fixture.reconnect.mockClear();fixture.prepare.mockClear()})
it.each([
 ['credits_exhausted','failed','积分不足'],['membership_expired','failed','会员已到期'],['','timeout','准备超时'],['','failed','云端服务'],
])('explains failed authorization preparation without exposing diagnostics: %s/%s',async(code,reason,message)=>{
 const h=createReactHarness(),client=new QueryClient(),captured:{host?:LibraryHost}={}
 fixture.wake.mockRejectedValue(new CloudComputerWakeError(reason as 'failed'|'timeout','Internal controller diagnostic',code||null))
 function Probe(){captured.host=useHomeLibraryHost({kind:'cloud',deviceId:'cloud'});return null}
 try{
  await h.render(<QueryClientProvider client={client}><Probe/></QueryClientProvider>)
  expect(fixture.wake).not.toHaveBeenCalled()
  const failed=captured.host!.prepareAssistantAction!()
  await expect(failed).rejects.toThrow(message)
  await expect(failed).rejects.toMatchObject({code:code||null,reason})
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(fixture.wake).toHaveBeenCalledWith('cloud',{signal:undefined,isOnline:expect.any(Function)})
  expect(fixture.reconnect).not.toHaveBeenCalled()
 }finally{h.cleanup();client.clear()}
})

it('passes cancellation to the controller and does not reconnect or start the tool afterwards',async()=>{
 const h=createReactHarness(),client=new QueryClient(),captured:{host?:LibraryHost}={}
 let signal:AbortSignal|undefined
 fixture.wake.mockImplementationOnce((_id:string,options:{signal:AbortSignal})=>{
  signal=options.signal
  return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}))
 })
 function Probe(){captured.host=useHomeLibraryHost({kind:'cloud',deviceId:'cloud'});return null}
 try{
  await h.render(<QueryClientProvider client={client}><Probe/></QueryClientProvider>)
  const abort=new AbortController()
  const run=captured.host!.integrations.cliToolPrepare('feishu',abort.signal)
  await vi.waitFor(()=>expect(fixture.wake).toHaveBeenCalledOnce())
  abort.abort()
  await expect(run).rejects.toMatchObject({name:'AbortError'})
  expect(signal?.aborted).toBe(true)
  expect(fixture.reconnect).not.toHaveBeenCalled()
  expect(fixture.prepare).not.toHaveBeenCalled()
 }finally{h.cleanup();client.clear()}
})
