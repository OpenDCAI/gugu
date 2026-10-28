// @vitest-environment jsdom
import {act} from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createReactHarness} from '../../../support/testHarness'
import {useAssistantWorkTasks} from '../../../../apps/desktop/src/components/assistant/assistant-panel-tasks'
const cloud=vi.hoisted(()=>({list:vi.fn(),refresh:null as null|(()=>void)}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{listAll:cloud.list},watchAssistantWork:(_o:string,_a:string,refresh:()=>void)=>{cloud.refresh=refresh;return ()=>{}}}))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore',()=>({getAgentPresenceSnapshot:()=>null,subscribeAgentPresence:()=>()=>{}}))
let harness:ReturnType<typeof createReactHarness>
const row={work_id:'work',title:'Saved task',coordinator_session_id:'home',coordinator_device_id:'home-device',executors:[{session_id:'child',device_id:'worker',agent_user_id:'agent'}],executor_outcomes:{},outcome:'active',updated_at:'2026-10-26T08:00:00Z'}
function View({owner}:{owner:string}){const read=useAssistantWorkTasks(owner,'assistant');return <p>{JSON.stringify(read)}</p>}
beforeEach(()=>{harness=createReactHarness();cloud.list.mockReset();cloud.refresh=null})
afterEach(()=>harness.cleanup())
it('keeps cached tasks and the latest error together across remounts, scoped to the owner',async()=>{
 cloud.list.mockResolvedValue([row]);await harness.render(<View owner="cached-owner"/>);
 expect(harness.container.textContent).toContain('Saved task')
 await harness.render(null)
 let fail!:(error:Error)=>void
 cloud.list.mockReturnValue(new Promise((_r,reject)=>{fail=reject}))
 await harness.render(<View owner="cached-owner"/>);
 expect(harness.container.textContent).toContain('Saved task')
 await act(async()=>fail(Object.assign(new Error('server failed'),{code:'503'})))
 expect(harness.container.textContent).toContain('Saved task')
 expect(harness.container.textContent).toContain('503')
 await harness.render(<View owner="other-owner"/>);
 expect(harness.container.textContent).not.toContain('Saved task')
})
it('does not start concurrent list reads for a burst of change events',async()=>{
 let finish!:(value:unknown[])=>void
 cloud.list.mockReturnValueOnce(new Promise(resolve=>{finish=resolve})).mockResolvedValue([row])
 await harness.render(<View owner="burst-owner"/>);
 await act(async()=>{for(let n=0;n<20;n++)cloud.refresh?.()})
 expect(cloud.list).toHaveBeenCalledTimes(1)
 await act(async()=>finish([]))
 expect(cloud.list).toHaveBeenCalledTimes(2)
 expect(harness.container.textContent).toContain('Saved task')
})
