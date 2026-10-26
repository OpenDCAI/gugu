// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
import { useAssistantWorkTasks } from '../../../../apps/desktop/src/components/assistant/assistant-panel-tasks'
import type {AssistantPanelWindow,AssistantPanelBridge} from '../../../../apps/desktop/src/lib/assistantPanelBridge'
const cloud=vi.hoisted(()=>({list:vi.fn(),refresh:null as null|(()=>void)}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list},watchAssistantWork:(_o:string,_a:string,fn:()=>void)=>{cloud.refresh=fn;return()=>{}}}))
const presence={subscribePresence:()=>()=>{},presence:()=>({reading:{status:'idle',detail:'done'},payload:{agentType:'codex'},local:{unseen:true}})}
let harness:ReturnType<typeof createReactHarness>
function View(){const read=useAssistantWorkTasks('owner','assistant');return <p>{read.state==='ok'?read.data.map(t=>`${t.workId}:${t.outcome}:${t.status?.detail}:${t.unseen}`).join(','):read.state}</p>}
beforeEach(()=>{harness=createReactHarness();cloud.list.mockReset();(window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__={work:presence} as unknown as AssistantPanelBridge})
afterEach(()=>{harness.cleanup();delete (window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__})
it('retains finished tasks without a machine and never interprets idle as completed work',async()=>{
 const record={work_id:'a',title:'Task',coordinator_session_id:'home',coordinator_device_id:'home-device',executors:[{session_id:'worker',device_id:'offline',agent_user_id:'agent'}],executor_outcomes:{},outcome:'active',updated_at:'2026-10-26T08:00:00Z'}
 cloud.list.mockResolvedValue([record,{...record,work_id:'b',outcome:'completed'}])
 await renderWithAppProviders(harness,<View/>);
 await vi.waitFor(()=>expect(harness.container.textContent).toContain('a:active:plain:true'))
 expect(harness.container.textContent).toContain('b:completed:done:true')
 cloud.list.mockResolvedValue([{...record,work_id:'b',outcome:'completed'}])
 await act(async()=>cloud.refresh?.())
 await vi.waitFor(()=>expect(harness.container.textContent).not.toContain('a:active'))
})
