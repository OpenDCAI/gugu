// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness} from '../../../support/testHarness'
import {MessageListSkeleton} from '../../../../apps/desktop/src/components/chat/MessageListSkeleton'
import {useAssistantWorkDetail} from '../../../../apps/desktop/src/components/assistant/useAssistantWorkDetail'
import {useTaskChatRows} from '../../../../apps/desktop/src/components/assistant/useTaskChatRows'
import {rememberAssistantTaskChat} from '../../../../apps/desktop/src/lib/assistantTaskChat'
const cloud=vi.hoisted(()=>({get:vi.fn(),historyAll:vi.fn()}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:cloud,watchAssistantWork:()=>()=>{}}))
let harness:ReturnType<typeof createReactHarness>
beforeEach(()=>{harness=createReactHarness()})
afterEach(()=>{harness.cleanup();vi.useRealTimers()})
it('does not flash placeholders before 300ms and does not reserve an extra message row',async()=>{
 vi.useFakeTimers()
 await harness.render(<MessageListSkeleton delayMs={300} overlay/>)
 expect(harness.container.querySelector('[data-skeleton-bubble]')).toBeNull()
 await act(async()=>vi.advanceTimersByTime(299))
 expect(harness.container.querySelector('[data-skeleton-bubble]')).toBeNull()
 await act(async()=>vi.advanceTimersByTime(1))
 expect(harness.container.querySelector('[data-skeleton-bubble]')).not.toBeNull()
 expect(harness.container.firstElementChild).toHaveProperty('style.position','absolute')
})
it('paints already-read work messages while the newly opened chat history is still pending',async()=>{
 const owner='first-paint-owner',assistant='first-paint-assistant',workId='first-paint-work',session='first-paint-session'
 const task={workId,title:'Known task',assistantId:assistant,taskAgentId:'first-paint-agent',task:{sessionId:session,deviceId:'home'},assistants:[{sessionId:'main',deviceId:'home'}]}
 const work={work_id:workId,title:task.title,assistant_user_id:assistant,owner_user_id:owner,outcome:'completed',executors:[{session_id:session,device_id:'home',agent_user_id:task.taskAgentId}],coordinator_session_id:'main',coordinator_device_id:'home'}
 cloud.get.mockResolvedValue({work,events:[{work_id:workId,message_id:'first-paint-result',kind:'completed',source_available:true,source_message_id:null,content:'Already known result',attachment_refs:[],from_session_id:session,to_session_id:'main',platform_received_at:'2026-10-26T08:00:00Z'}]})
 cloud.historyAll.mockReturnValue(new Promise(()=>{}))
 rememberAssistantTaskChat(owner,task)
 function Rows(){const result=useTaskChatRows([],owner,task.taskAgentId,true,'');return <div>{result.rows.map(row=><p key={row.message.id}>{row.message.content}</p>)}</div>}
 function Page(){const read=useAssistantWorkDetail(owner,assistant,workId,session);return read.detail?<Rows/>:null}
 await harness.render(<Page/>)
 await vi.waitFor(()=>expect(harness.container.textContent).toContain('Already known result'))
 expect(cloud.historyAll).toHaveBeenCalled()
})
