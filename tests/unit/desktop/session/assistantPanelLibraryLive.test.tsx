// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import type { AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import { createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
const world=vi.hoisted(()=>({rpc:vi.fn(),subscribe:vi.fn((_owner:string,_event:string,_callback:()=>void,_options?:{onSubscribed?:()=>void})=>({})),unsubscribe:vi.fn(),body:vi.fn()}))
vi.mock('@/lib/supabase',()=>({identityDb:{rpc:(...args:unknown[])=>({abortSignal:()=>world.rpc(...args)})},chatDb:{rpc:vi.fn()}}))
vi.mock('@/lib/realtimeChannel',()=>({subscribePrivateUserEventBus:world.subscribe,unsubscribePrivateUserEventBus:world.unsubscribe}))
vi.mock('@gugu/core/cloud/assistantPanelBodies',()=>({readAssistantPanelBody:world.body,uploadAssistantPanelBody:vi.fn()}))
vi.mock('@/components/devices/AssistantDevicesPage',()=>({AssistantDevicesPage:()=>null}))
vi.mock('@/components/assistant/AssistantProjectsLibrary',()=>({AssistantProjectsCard:()=>null,AssistantProjectsLibrary:()=>null}))
vi.mock('@/components/assistant/AssistantLibraryEditor',()=>({AssistantLibraryEditor:()=>null}))
vi.mock('@/components/assistant/assistant-library-client',()=>({libraryHost:vi.fn()}))
vi.mock('@/components/assistant/assistant-app-client',()=>({assistantAppClient:vi.fn()}))
vi.mock('@/mobile/agent-watch/sessionpage-rpc',()=>({onMachineEvent:vi.fn(()=>()=>{})}))
vi.mock('@/session/renderer/lib/ipc',()=>({onMachineEvent:vi.fn(()=>()=>{})}))
vi.mock('@/mobile/assistant/PhoneMachineView',()=>({PhoneMachineView:()=>null}))
vi.mock('@/components/markdown/Markdown',()=>({Markdown:()=>null}))
import { publishRendererSession } from '@/lib/sessionPublication'
import { installAssistantPanelHost } from '@/components/assistant/assistant-panel-host'
import { useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files'
import { AssistantLibraryVolume } from '@/components/assistant/AssistantLibraryVolume'
import { PhoneLibraryVolume } from '@/mobile/assistant/PhoneLibraryVolume'
import type { AssistantPanelWindow } from '@/lib/assistantPanelBridge'
import { assistantPanelCacheStore } from '@/components/assistant/assistant-panel-cache'
let h:ReturnType<typeof createReactHarness>,items:AssistantPanelItem[]
const row=(key:string,data:Record<string,unknown>):AssistantPanelItem=>({assistant_user_id:'assistant',owner_user_id:'owner',device_id:'home',domain:'capabilities',resource_key:key,revision:'1',data,body_item_id:null,body_sha256:null,deleted_at:null,observed_at:null,updated_at:'2026-10-27'})
function Page({phone}:{phone:boolean}){
 const machine=useCloudAssistantFiles('assistant','chat','home')
 if(!machine)return null
 return phone?<PhoneLibraryVolume kind="capabilities" machine={{state:'ready',machine}} assistant={{id:'assistant',display_name:'咕咕',avatar:null,created_at:null}} askInChat={()=>{}}/>
 :<AssistantLibraryVolume kind="capabilities" machine={machine} assistantId="assistant" askInChat={()=>{}}/>
}
beforeEach(()=>{
 h=createReactHarness();vi.clearAllMocks()
 items=[row('__collection__:home',{state:'ready',schemaVersion:1,itemCount:0})]
 world.rpc.mockImplementation(async()=>({data:{version:1,revision:'1',items:[...items],application:[]},error:null,status:200}))
 publishRendererSession('SIGNED_IN',{user:{id:'owner'},access_token:'fixture'} as Session);installAssistantPanelHost()
})
afterEach(()=>{h.cleanup();publishRendererSession('SIGNED_OUT',null);delete(window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__})
function addCapability(){items=[row('__collection__:home',{state:'ready',schemaVersion:1,itemCount:1}),row('rice',{name:'吃大米',description:'测试能力',group:null,modifiedAt:'2026-10-27T01:00:00Z'})]}
it.each([false,true])('updates the already-open library from the cloud event without downloading bodies (phone=%s)',async phone=>{
 await renderWithAppProviders(h,<Page phone={phone}/>);expect(h.container.textContent).not.toContain('吃大米')
 addCapability();const callback=world.subscribe.mock.calls.at(-1)![2]
 await act(async()=>{callback()})
 expect(h.container.textContent).toContain('吃大米');expect(world.body).not.toHaveBeenCalled()
})
it('reconciles an update missed between initial read and subscription or during reconnect',async()=>{
 await renderWithAppProviders(h,<Page phone={false}/>);addCapability()
 const subscribed=world.subscribe.mock.calls.at(-1)?.[3]?.onSubscribed
 expect(subscribed).toBeTypeOf('function')
 await act(async()=>{subscribed!()})
 expect(h.container.textContent).toContain('吃大米')
})
it.each([false,true])('paints its local capability copy immediately while the network is pending or offline (phone=%s)',async phone=>{
 await assistantPanelCacheStore().ready;addCapability()
 assistantPanelCacheStore().files('owner','assistant').saveSnapshot({version:1,revision:'1',items:[...items],application:[]})
 const network=Promise.withResolvers<{data:null;error:{code:string;message:string};status:number}>()
 world.rpc.mockReturnValue(network.promise)
 await renderWithAppProviders(h,<Page phone={phone}/>)
 expect(h.container.textContent).toContain('吃大米');expect(h.container.textContent).not.toMatch(/正在读取|正在加载/)
 await act(async()=>{network.resolve({data:null,error:{code:'ENOTFOUND',message:'network unavailable'},status:0})})
 expect(h.container.textContent).toContain('吃大米');expect(h.container.textContent).not.toMatch(/正在读取|正在加载/)
 expect(h.container.querySelector('[role="status"]')).toBeNull();expect(h.container.querySelector('[role="alert"]')).toBeNull()
})
