// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,expect,it,vi} from 'vitest'
import {createReactHarness} from '../../../support/testHarness'
import {useLinkNavigation} from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import {OPEN_ASSISTANT_TASK_CHAT} from '../../../../apps/desktop/src/lib/assistantTaskChat'
const cloud=vi.hoisted(()=>({list:vi.fn()}))
vi.mock('react-i18next',async original=>({...await original<object>(),useTranslation:()=>({t:(key:string)=>key})}))
vi.mock('../../../../apps/desktop/src/lib/chat',()=>({chatService:{}}))
vi.mock('../../../../apps/desktop/src/lib/guguLinks',()=>({OPEN_LINK_TARGET:'gugu:open-link-target'}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list}}))
vi.mock('../../../../apps/desktop/src/lib/assistantShellBridge',()=>({readAssistantShellBridge:()=>({getSnapshot:()=>({assistant:{id:'assistant'},ownerId:'owner',chatId:'assistant-dm'})})}))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory',()=>({liveDeviceSessions:()=>[],listedSession:()=>{throw new Error('Must not resolve an account work through a device directory')}}))
vi.mock('../../../../apps/desktop/src/store/devicesCache',()=>({readCachedDevices:()=>[]}))
const harness=createReactHarness()
afterEach(()=>harness.cleanup())
it('opens a session link from its account work before any device or panel directory has received it',async()=>{
 const opened=vi.fn(),openAssistant=vi.fn()
 cloud.list.mockResolvedValue([{work_id:'new-work',assistant_user_id:'assistant',owner_user_id:'owner',title:'Just dispatched',executors:[{session_id:'prepared-session',device_id:'sleeping',agent_user_id:null}],coordinator_session_id:'main',coordinator_device_id:'home'}])
 function Navigation(){useLinkNavigation({ownerId:'owner',chats:[],contacts:[],openChat:vi.fn(),openFile:vi.fn(),openApp:vi.fn(),openProject:vi.fn(),openOwnApp:vi.fn(),openAssistant});return null}
 await harness.render(<Navigation/>);window.addEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)
 try{
  await act(async()=>{await new Promise<void>((resolve,reject)=>window.dispatchEvent(new CustomEvent('gugu:open-link-target',{detail:{target:{kind:'session',sessionId:'prepared-session'},resolve,reject},cancelable:true})))})
  expect(cloud.list).toHaveBeenCalledExactlyOnceWith('assistant')
  expect(openAssistant).toHaveBeenCalledWith(true)
  expect(opened.mock.calls[0][0].detail).toMatchObject({workId:'new-work',title:'Just dispatched',task:{sessionId:'prepared-session',deviceId:'sleeping'}})
 }finally{window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT,opened)}
})
