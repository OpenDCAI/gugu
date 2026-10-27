// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from 'vitest'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import type { LibraryHost } from '../../../../apps/desktop/src/session/renderer/features/library/library-host'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const fixture=vi.hoisted(()=>({wake:vi.fn(),start:vi.fn(),reconnect:vi.fn(),failure:null as null|{code:string;reason:string}}))
vi.mock('@/lib/assistantPanelBridge',()=>({useAssistantPanelAccountId:()=> 'owner',requireAssistantPanelBridge:vi.fn()}))
vi.mock('@/components/assistant/assistant-panel-files',()=>({ASSISTANT_PANEL_CHANGED:'panel-changed',useCloudAssistantFiles:()=>({panel:{ownerId:'owner',assistantId:'assistant',assertCurrent:async()=>{}}})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell',()=>({useAssistantShell:()=>({assistant:{id:'assistant'},chatId:'dm'})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host',()=>({createRemoteLibraryHost:(info:unknown)=>({key:'remote',remote:info,integrations:{},github:{}}),LibraryHostProvider:({children}:{children:unknown})=>children,LOCAL_LIBRARY_HOST:{},useLibraryHost:vi.fn()}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider',()=>({IntegrationsProvider:({children}:{children:unknown})=>children,useIntegrationsContext:vi.fn()}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store',()=>({remoteHostsStore:{device:()=>({isOnline:false}),wakeCloudComputer:fixture.wake,start:fixture.start,reconnect:fixture.reconnect,connectionState:()=> 'connected',wakeFailure:()=>fixture.failure}}))
import { useHomeLibraryHost } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-integrations'
beforeEach(()=>{fixture.wake.mockReset();fixture.start.mockClear();fixture.reconnect.mockClear();fixture.failure=null})
it.each([
 ['credits_exhausted','failed','积分不足'],['membership_expired','failed','会员已到期'],['','timeout','准备超时'],['','failed','云端服务'],
])('explains failed authorization preparation without exposing diagnostics: %s/%s',async(code,reason,message)=>{
 const h=createReactHarness(),client=new QueryClient(),captured:{host?:LibraryHost}={}
 fixture.wake.mockResolvedValue(false);fixture.failure={code,reason}
 function Probe(){captured.host=useHomeLibraryHost({kind:'cloud',deviceId:'cloud'});return null}
 try{
  await h.render(<QueryClientProvider client={client}><Probe/></QueryClientProvider>)
  expect(fixture.wake).not.toHaveBeenCalled()
  await expect(captured.host!.prepareAssistantAction!()).rejects.toThrow(message)
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(fixture.wake).toHaveBeenCalledWith('cloud')
  expect(fixture.reconnect).not.toHaveBeenCalled()
 }finally{h.cleanup();client.clear()}
})
