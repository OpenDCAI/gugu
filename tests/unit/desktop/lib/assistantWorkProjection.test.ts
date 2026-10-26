import { describe,expect,it } from 'vitest'
import type { AssistantWorkEvent,AssistantWorkTask } from '@gugu/core/cloud/assistantWork'
import { assistantWorkExchanges,assistantWorkTasks } from '../../../../apps/desktop/src/components/assistant/assistant-work-projection'

const work = { work_id: 'work-a',title: 'Review',coordinator_session_id: 'home',coordinator_device_id: 'home-device',
  executors: [{ session_id: 'worker',device_id: 'worker-device',agent_user_id: 'agent' }],outcome: 'active',executor_outcomes: {},
  updated_at: '2026-10-26T08:00:00Z' } as AssistantWorkTask

describe('account work view',() => {
  it('keeps distinct tasks for the same executor, including a completed task after its directory vanishes',() => {
    const rows = assistantWorkTasks([work,{ ...work,work_id: 'work-b',outcome: 'completed' }])
    expect(rows.map(row => row.key)).toEqual(['work-a:worker','work-b:worker'])
    expect(rows[1]).toMatchObject({ workId: 'work-b',outcome: 'completed',assistants: [{ deviceId: 'home-device',sessionId: 'home' }] })
  })
  it('scopes collaboration by work id and preserves native file refs and original source ids',() => {
    const file = { attachment_id: '10000000-0000-4000-8000-000000000001',file_name: 'result.pdf',sha256: 'a'.repeat(64),size_bytes: 42,content_type: 'application/pdf' }
    const event = { work_id: 'work-a',message_id: 'event',seq: '9007199254740994',from_session_id: 'worker',to_session_id: 'home',
      content: 'Finished',source_available: true,source_message_id: 'original',attachment_refs: [file],platform_received_at: work.updated_at } as AssistantWorkEvent
    const rows = assistantWorkExchanges([event,{ ...event,work_id: 'other' },{ ...event,message_id: 'hidden',source_available: false,content: null }],'work-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'event',sourceMessageId: 'original',fromSessionId: 'worker',toSessionId: 'home' })
    expect(rows[0]!.content).toContain(file.attachment_id)
    expect(rows[0]!.content).toContain('Finished')
    expect(assistantWorkExchanges([{...event,occurred_at:'2026-10-20T08:00:00Z'}],'work-a')[0]!.createdAt).toBe('2026-10-20T08:00:00Z')
  })
})
