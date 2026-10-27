// @vitest-environment jsdom
import {act} from 'react'
import type {AssistantPanelWindow,AssistantPanelBridge} from '../../../../apps/desktop/src/lib/assistantPanelBridge'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness,renderWithAppProviders,clickElement} from '../../../support/testHarness'
import {PhoneTasks} from '../../../../apps/desktop/src/mobile/assistant/PhoneTasks'
import {AssistantTasksPage} from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-tasks'
import {OPEN_ASSISTANT_TASK_CHAT} from '../../../../apps/desktop/src/lib/assistantTaskChat'
import type {PhonePageProps} from '../../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import type {AssistantContext} from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const cloud=vi.hoisted(()=>({list:vi.fn(),schedules:vi.fn(),refresh:null as null|(()=>void)}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list},watchAssistantWork:(_o:string,_a:string,refresh:()=>void)=>{cloud.refresh=refresh;return ()=>{}}}))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore',()=>({subscribeAgentPresence:()=>()=>{},getAgentPresenceSnapshot:()=>({reading:{status:'idle',detail:'done'},payload:{agentType:'codex'},local:{unseen:true}})}))
vi.mock('../../../../apps/desktop/src/store/devicesContext',()=>({useDevicesStore:()=>({devices:[],phones:[]})}))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory',async original=>({...await original<object>(),useDirectoryDevices:()=>[],useLiveDeviceSessions:()=>{throw new Error('Task lists must not read device sessions')}}))
let harness:ReturnType<typeof createReactHarness>
beforeEach(()=>{harness=createReactHarness();(window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__={accountId:()=> 'owner',subscribeAccount:()=>()=>{},subscribeChanges:()=>()=>{},files:()=>({paths:{memoryDir:'memory'},collection:cloud.schedules})} as unknown as AssistantPanelBridge;cloud.schedules.mockReset().mockResolvedValue([]);cloud.list.mockReset().mockResolvedValue([{work_id:'work',title:'codex (2)',coordinator_session_id:'home-session',coordinator_device_id:'home',executors:[{session_id:'worker',device_id:'phone',agent_user_id:'executor'}],executor_outcomes:{},outcome:'completed',updated_at:'2026-10-26T08:00:00Z'}])})
afterEach(()=>{harness.cleanup();delete (window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__})
it.each(['phone','desktop'])('%s can open a dispatched task before its agent identity is admitted',async shell=>{
 const assistantId=`pending-${shell}`
 cloud.list.mockResolvedValue([{work_id:'prepared-work',title:'Just dispatched',coordinator_session_id:'main',coordinator_device_id:'home',executors:[{session_id:'prepared-seat',device_id:'sleeping',agent_user_id:null}],executor_outcomes:{},outcome:'active',updated_at:new Date().toISOString()}])
 const common={assistant:{id:assistantId,display_name:'Assistant',avatar:null,created_at:null},chatId:'dm',ownerName:'Owner',home:{kind:'cloud',deviceId:'home'},homeDeviceId:'home',readiness:'unreachable',askInChat:vi.fn(),go:vi.fn()}
 const opened=vi.fn();window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
 try{
  await renderWithAppProviders(harness,<QueryClientProvider client={new QueryClient()}>{shell==='phone'?<PhoneTasks {...common as unknown as PhonePageProps} machine={{state:'opening'}} sub={null}/>:<AssistantTasksPage context={{...common,machineLoading:true,route:{tab:'tasks'}} as unknown as AssistantContext}/>}</QueryClientProvider>,{auth:{id:'owner'}})
  await vi.waitFor(()=>expect(harness.container.querySelector('[data-testid="assistant-subagent-prepared-seat"]')).not.toBeNull())
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-subagent-prepared-seat"]')!)
  expect(opened).toHaveBeenCalledOnce()
  expect(opened.mock.calls[0][0].detail).toMatchObject({workId:'prepared-work',title:'Just dispatched',task:{sessionId:'prepared-seat'}})
 }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)}
})
it.each(['phone','desktop'])('%s reads an ended account task with no connected machine and opens its exact work',async shell=>{
 const assistant={id:'assistant',display_name:'咕咕',avatar:null,created_at:null}
 const common={assistant,chatId:'dm',ownerName:'Owner',home:{kind:'cloud',deviceId:'home'},homeDeviceId:'home',readiness:'unreachable',askInChat:vi.fn(),go:vi.fn()}
 const phone={...common,machine:{state:'error',error:new Error('Host asleep'),retry:vi.fn()},cloudDeviceId:'home',sub:null,open:vi.fn()} as PhonePageProps
 const desktop={...common,machine:undefined,machineLoading:true,machineError:new Error('Host asleep'),retryMachine:vi.fn(),snapshot:null,route:{tab:'tasks'}} as AssistantContext
 const opened=vi.fn();window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
 try{
  await renderWithAppProviders(harness,<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{shell==='phone'?<PhoneTasks {...phone}/>:<AssistantTasksPage context={desktop}/>}</QueryClientProvider>,{auth:shell==='desktop'?null:{id:'owner'}})
  await vi.waitFor(()=>expect(harness.container.querySelector('[data-testid="assistant-subagent-worker"]')).not.toBeNull())
  expect(harness.container.textContent).not.toContain('Host asleep')
  expect(cloud.list).toHaveBeenCalledWith('assistant')
  cloud.list.mockRejectedValueOnce(Object.assign(new Error('private server detail'),{code:'503'})).mockResolvedValue([{work_id:'work',title:'Recovered task',coordinator_session_id:'home-session',coordinator_device_id:'home',executors:[{session_id:'worker',device_id:'phone',agent_user_id:'executor'}],executor_outcomes:{},outcome:'completed',updated_at:'2026-10-26T08:00:00Z'}])
  await act(async()=>cloud.refresh?.())
  expect(harness.container.querySelector('[data-testid="assistant-subagent-worker"]')).not.toBeNull()
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
  expect(harness.container.textContent).not.toContain('private server detail')
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1600))})
  expect(harness.container.textContent).toContain('Recovered task')
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-subagent-worker"]')!)
  expect(opened.mock.calls[0][0].detail).toMatchObject({workId:'work',outcome:'completed',taskAgentId:'executor',assistants:[{deviceId:'home',sessionId:'home-session'}]})
 }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)}
})
