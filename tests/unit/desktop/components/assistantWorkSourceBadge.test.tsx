// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest'
import {createReactHarness,clickElement,renderWithAppProviders} from '../../../support/testHarness'
import {ActivitySourceBadge} from '../../../../apps/desktop/src/components/chat/ActivitySourceBadge'
import {OPEN_ASSISTANT_TASK_CHAT} from '../../../../apps/desktop/src/lib/assistantTaskChat'
const cloud=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list},watchAssistantWork:()=>()=>{}}))
vi.mock('../../../../apps/desktop/src/lib/assistantWorkReadBridge',()=>({useAssistantWorkOwnerId:()=> 'badge-owner'}))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge',()=>({readAssistantShellBridge:()=>({getSnapshot:()=>({assistant:{id:'badge-assistant'},chatId:'10000000-0000-4000-8000-000000000001'})})}))
vi.mock('../../../../apps/desktop/src/store/devicesContext',()=>({useDevicesStore:()=>({devices:[]})}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store',()=>({remoteHostsStore:{allListedSessions:()=>[]}}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions',()=>({localHomeSessions:{sessions:[]}}))
const harness=createReactHarness()
afterEach(()=>harness.cleanup())
it('shows new work links without a device directory and shares one account read across message badges',async()=>{
 const chatId='10000000-0000-4000-8000-000000000001',messageId='10000000-0000-4000-8000-000000000002'
 cloud.list.mockResolvedValue([{work_id:'prepared-work',assistant_user_id:'badge-assistant',title:'New assignment',source_link:`gugu-chat://${chatId}/${messageId}`,executors:[{session_id:'prepared',device_id:'sleeping',agent_user_id:null}],coordinator_session_id:'main',coordinator_device_id:'home'}])
 const opened=vi.fn();window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
 try{
  await renderWithAppProviders(harness,<>{[1,2,3].map(key=><ActivitySourceBadge key={key} chatId={chatId} messageId={messageId}/>)}</>)
  await vi.waitFor(()=>expect(harness.container.querySelectorAll('.activity-source-link')).toHaveLength(3))
  expect(cloud.list).toHaveBeenCalledExactlyOnceWith('badge-assistant')
  await clickElement(harness.container.querySelector<HTMLElement>('.activity-source-link')!)
  expect(opened.mock.calls[0][0].detail).toMatchObject({workId:'prepared-work',title:'New assignment',taskAgentId:null})
 }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)}
})
