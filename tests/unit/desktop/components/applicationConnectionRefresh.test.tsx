// @vitest-environment jsdom
import {act} from 'react'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness,waitForCondition} from '../../../support/testHarness'
import {ASSISTANT_PANEL_CHANGED} from '../../../../apps/desktop/src/components/assistant/assistant-panel-events'
import {IntegrationsProvider,useIntegrationsContext} from '../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider'
import {connectorState} from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-connector-status'
import {assistantApplicationCounts} from '../../../../apps/desktop/src/components/assistant/assistant-app-connections'
const f=vi.hoisted(()=>({connected:false,readFails:false,host:null as unknown}))
vi.mock('@renderer/features/library/library-host',()=>({useLibraryHost:()=>f.host}))
vi.mock('@renderer/lib/chat/chat-mention-provider',()=>({registerIssueMentionIcons:vi.fn()}))
vi.mock('@/components/assistant/assistant-app-client',()=>({reportAssistantAppChange:vi.fn(async()=>{})}))
vi.mock('@renderer/lib/ipc',()=>({rpcOn:()=>({})}))
const items=[{id:'dingtalk',name:'钉钉',auth:{methods:[]},capabilities:{}}] as never[]
let h:ReturnType<typeof createReactHarness>,client:QueryClient,connect:()=>Promise<unknown>
function Probe(){
 const v=useIntegrationsContext()
 connect=()=>v.connectIntegration('dingtalk',{})
 const count=assistantApplicationCounts(v.integrations,v.configuredConnections,v.checkedConnections,null).connected
 return <div data-testid="state" data-state={connectorState(v.configuredConnections.dingtalk,v.checkedConnections.dingtalk,v.connectionCheckError ?? v.configuredConnectionsError,true)} data-has-list={v.hasList}>{v.checkedConnections.dingtalk?.connected?'connected':'off'}|{String(v.configuredConnections.dingtalk===true)}|{count}</div>
}
beforeEach(()=>{
 f.connected=false;f.readFails=false;h=createReactHarness();client=new QueryClient({defaultOptions:{queries:{gcTime:0,retry:false}}})
 f.host={key:'panel:owner:assistant',assistantPanelExpected:true,assistantPanel:{invalidate:vi.fn(()=>window.dispatchEvent(new Event(ASSISTANT_PANEL_CHANGED)))},integrations:{
  list:async()=>{if(f.readFails)throw Error('snapshot unavailable');return items},checkAllConnections:async()=>{if(f.readFails)throw Error('snapshot unavailable');return {dingtalk:{connected:f.connected,errorType:f.connected?undefined:'authorization_expired'}}},checkConfiguredConnections:async()=>{if(f.readFails)throw Error('snapshot unavailable');return {dingtalk:f.connected}},connect:async()=>{f.connected=true;return{success:true}},
 }}
})
afterEach(()=>{h.cleanup();client.clear()})
async function mount(){await h.render(<QueryClientProvider client={client}><IntegrationsProvider><Probe/></IntegrationsProvider></QueryClientProvider>);await waitForCondition(()=>h.container.textContent==='off|false|0','initial state')}
it('refreshes the mounted detail state, list state and profile count after authorization completes',async()=>{
 await mount()
 await act(async()=>{await connect()})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','updated connection state')
 expect((f.host as {assistantPanel:{invalidate:unknown}}).assistantPanel.invalidate).toHaveBeenCalledOnce()
})
it('receives another surface’s connection publication without reopening the page',async()=>{
 await mount()
 await act(async()=>{f.connected=true;window.dispatchEvent(new Event(ASSISTANT_PANEL_CHANGED))})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','updated connection state')
})

it('keeps the last published connection during a failed cloud refresh and applies a later authorization failure',async()=>{
 await mount()
 await act(async()=>{await connect()})
 await waitForCondition(()=>h.container.textContent==='connected|true|1','connected')
 await act(async()=>{f.readFails=true;await client.invalidateQueries()})
 const state=h.container.querySelector('[data-testid="state"]')!
 expect(state.getAttribute('data-state')).toBe('connected')
 expect(state.getAttribute('data-has-list')).toBe('true')
 await act(async()=>{f.readFails=false;f.connected=false;await client.invalidateQueries()})
 await waitForCondition(()=>h.container.textContent==='off|false|0','published disconnect')
 expect(state.getAttribute('data-state')).toBe('notConnected')
 // A new credential result is still authoritative even though an earlier read failed.
 await act(async()=>{await client.setQueryData(['issues:connection-status','panel:owner:assistant','configured'],{dingtalk:true})})
 await waitForCondition(()=>state.getAttribute('data-state')==='needsReauth','published authorization failure')
 expect(state.getAttribute('data-state')).toBe('needsReauth')
})
