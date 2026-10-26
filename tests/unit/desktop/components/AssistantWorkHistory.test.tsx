// @vitest-environment jsdom
import { act } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
import { rememberAssistantTaskChat,showAssistantTaskChat } from '../../../../apps/desktop/src/lib/assistantTaskChat'
import { useTaskChatRows } from '../../../../apps/desktop/src/components/assistant/useTaskChatRows'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const cloud = vi.hoisted(() => ({ history: vi.fn(),list:vi.fn(),watch: vi.fn(),refresh: null as null | (() => void) }))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',() => ({ assistantWorkCloud: { historyAll: cloud.history,listAll:cloud.list },
  watchAssistantWork: (_owner: string,_assistant: string,refresh: () => void) => { cloud.refresh=refresh; cloud.watch(); return () => {} } }))
vi.mock('../../../../apps/desktop/src/store/devicesContext',() => ({ useDevicesStore: () => { throw new Error('Task history must not query devices') } }))
let harness: ReturnType<typeof createReactHarness>
const request = (workId: string) => ({ workId,assistantId: 'assistant',taskAgentId: 'executor',task: { deviceId: 'offline',sessionId: 'worker' },assistants: [{ deviceId: 'offline-home',sessionId: 'home' }] })
const event = (workId: string,content: string) => ({ work_id: workId,message_id: workId,seq: '1',from_session_id: 'home',to_session_id: 'worker',
  content,source_available: true,source_message_id: null,attachment_refs: [],platform_received_at: '2026-10-26T08:00:00Z' })
function View() { const { rows,notice } = useTaskChatRows([],'owner','executor',true,''); return <>{notice}<p>{rows.map(row=>row.message.content).join(',')}</p></> }
beforeEach(() => { harness=createReactHarness(); cloud.history.mockReset(); cloud.list.mockReset(); cloud.watch.mockClear(); cloud.refresh=null; showAssistantTaskChat(null) })
afterEach(() => { harness.cleanup(); showAssistantTaskChat(null) })
it('reads cloud collaboration with every device offline and has no device retry or sync notice',async () => {
  cloud.history.mockResolvedValue([event('work-a','Cloud result')])
  rememberAssistantTaskChat('owner',request('work-a'))
  await renderWithAppProviders(harness,<View />)
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Cloud result'))
  expect(cloud.history).toHaveBeenCalledWith('assistant','work-a')
  expect(harness.container.querySelector('[data-testid="task-collaboration-retry"]')).toBeNull()
  cloud.history.mockRejectedValue(new Error('Account API offline'))
  await act(async () => cloud.refresh?.())
  expect(harness.container.textContent).toContain('Cloud result')
  expect(harness.container.textContent).not.toMatch(/待同步|重试|暂时无法/)
})
it('selects distinct work for the same executor and replaces removed source content on reread',async () => {
  cloud.history.mockImplementation(async (_a: string,w: string) => [event(w,w)])
  rememberAssistantTaskChat('owner',request('work-a'))
  await renderWithAppProviders(harness,<View />)
  await act(async()=> { rememberAssistantTaskChat('owner',request('work-b')); showAssistantTaskChat({ ownerId: 'owner',request: request('work-b'),name: 'worker' }) })
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('work-b'))
  expect(harness.container.textContent).not.toContain('work-a')
  cloud.history.mockResolvedValue([{ ...event('work-b','removed'),source_available: false,content: null }])
  await act(async()=>cloud.refresh?.())
  await vi.waitFor(()=>expect(harness.container.textContent).not.toContain('work-b'))
})
it('recovers a transient account read in the background without a retry button',async()=>{
  cloud.history.mockRejectedValueOnce(new Error('Transient account connection')).mockResolvedValue([event('work-retry','Recovered cloud history')])
  rememberAssistantTaskChat('owner',request('work-retry'))
  await renderWithAppProviders(harness,<View />)
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1100))})
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Recovered cloud history'),{timeout:2500})
  expect(harness.container.querySelector('button')).toBeNull()
})

it('resolves a pre-ledger task link from account assignments without contacting its old device',async()=>{
  cloud.list.mockResolvedValue([{work_id:'legacy-work',coordinator_session_id:'home',coordinator_device_id:'offline-home',executors:[{session_id:'worker',device_id:'offline'}]},
    {work_id:'other-work',coordinator_session_id:'other-home',coordinator_device_id:'offline-home',executors:[{session_id:'worker',device_id:'offline'}]}])
  cloud.history.mockResolvedValue([event('legacy-work','Original phone collaboration')])
  const legacy={...request('unused'),workId:undefined}
  rememberAssistantTaskChat('owner',legacy)
  await renderWithAppProviders(harness,<View />)
  await vi.waitFor(()=>expect(harness.container.textContent).toContain('Original phone collaboration'))
  expect(cloud.list).toHaveBeenCalledWith('assistant')
  expect(cloud.history).toHaveBeenCalledWith('assistant','legacy-work')
  expect(cloud.history).not.toHaveBeenCalledWith('assistant','other-work')
})
