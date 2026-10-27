import { describe, expect, it, vi } from 'vitest'
import { createAssistantWorkClient } from '@gugu/core/cloud/assistantWork'
import {setCoreLoggerFactory} from '@gugu/core/log'

const owner = '10000000-0000-4000-8000-000000000001'
const assistant = '10000000-0000-4000-8000-000000000002'
const work = '10000000-0000-4000-8000-000000000003'
const message = '10000000-0000-4000-8000-000000000004'
const operation = '10000000-0000-4000-8000-000000000005'
const now = '2026-10-26T08:00:00+00:00'
const row = (id = work, sequence = '1') => ({ owner_user_id: owner,assistant_user_id: assistant,work_id: id,created_seq: sequence,
  title: 'Check result',coordinator_session_id: 'assistant-session',coordinator_device_id: 'assistant-device',
  executors: [{ session_id: 'task-session',device_id: 'task-device',agent_user_id: null }],source_link: null,
  outcome: 'active',executor_outcomes: {},terminal_version: '0',created_at: now,updated_at: now })
const event = () => ({ owner_user_id: owner,work_id: work,message_id: message,seq: '2',kind: 'completed',
  from_session_id: 'task-session',from_device_id: 'task-device',to_session_id: 'assistant-session',to_device_id: 'assistant-device',
  executor_session_id: 'task-session',content: 'Verified',attachment_refs: [],source_chat_id: null,source_message_id: null,
  source_available: true,terminal_version: '2',platform_received_at: now,executor_admitted_at: null,assistant_admitted_at: null,
  owner_delivered_at: null,owner_chat_id: null,owner_message_id: null,delivery_state: 'pending' })

describe('account assistant work client', () => {
  it('opens a prepared work directly by id before its executor has an agent identity',async()=>{
    const transport=vi.fn().mockResolvedValue({data:{work:row(),events:[],next_after:null},error:null})
    const detail=await createAssistantWorkClient(transport,()=>owner).get(assistant,work)
    expect(detail.work).toMatchObject({work_id:work,executors:[{session_id:'task-session',agent_user_id:null}]})
    expect(transport).toHaveBeenCalledExactlyOnceWith('assistant_work_history',expect.objectContaining({p_assistant:assistant,p_work_id:work}))
  })
  it('rejects a direct task lookup whose work belongs to another assistant',async()=>{
    const transport=vi.fn().mockResolvedValue({data:{work:{...row(),assistant_user_id:owner},events:[],next_after:null},error:null})
    await expect(createAssistantWorkClient(transport,()=>owner).get(assistant,work)).rejects.toMatchObject({code:'invalid-response'})
  })
  it('skips a malformed task without losing the following page cursor',async()=>{
    const warn=vi.fn(),restore=setCoreLoggerFactory(()=>({warn,info:vi.fn(),debug:vi.fn(),error:vi.fn()}))
    try {
      const transport=vi.fn().mockResolvedValueOnce({data:{items:[row(work,'3'),{...row(message,'2'),executors:null}],next_before:'2'},error:null})
        .mockResolvedValueOnce({data:{items:[row(operation,'1')],next_before:null},error:null})
      expect((await createAssistantWorkClient(transport,()=>owner).listAll(assistant)).map(r=>r.work_id)).toEqual([work,operation])
      expect(transport.mock.calls[1]![1].p_before).toBe('2')
      expect(warn).toHaveBeenCalledOnce()
    } finally {restore()}
  })
  it('skips a malformed history row and advances even when the whole page is malformed',async()=>{
    const warn=vi.fn(),restore=setCoreLoggerFactory(()=>({warn,info:vi.fn(),debug:vi.fn(),error:vi.fn()}))
    try {
      const transport=vi.fn().mockResolvedValueOnce({data:{events:[{...event(),attachment_refs:'bad'}],next_after:'2'},error:null})
        .mockResolvedValueOnce({data:{events:[{...event(),seq:'3'}],next_after:null},error:null})
      expect(await createAssistantWorkClient(transport,()=>owner).historyAll(assistant,work)).toHaveLength(1)
      expect(transport.mock.calls[1]![1].p_after).toBe('2')
      expect(warn).toHaveBeenCalledOnce()
    } finally {restore()}
  })
  it('reads all task pages directly from the cloud with lossless bigint cursors', async () => {
    const other = '10000000-0000-4000-8000-000000000006'
    const transport = vi.fn().mockResolvedValueOnce({ data: { items: [row(work,'9007199254740994')],next_before: '9007199254740994' },error: null })
      .mockResolvedValueOnce({ data: { items: [row(other,'9007199254740993')],next_before: null },error: null })
    const client = createAssistantWorkClient(transport,() => owner)
    expect((await client.listAll(assistant)).map(item => item.work_id)).toEqual([work,other])
    expect(transport.mock.calls.map(call => call[0])).toEqual(['assistant_work_list','assistant_work_list'])
    expect(transport.mock.calls[1]![1].p_before).toBe('9007199254740994')
  })

  it('refuses a repeated or reversed page instead of looping or claiming complete data', async () => {
    const transport = vi.fn().mockResolvedValue({ data: { items: [row()],next_before: '1' },error: null })
    await expect(createAssistantWorkClient(transport,() => owner).listAll(assistant)).rejects.toMatchObject({ code: 'invalid-response' })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('rejects a response belonging to another account or assistant', async () => {
    const transport = vi.fn().mockResolvedValue({ data: { items: [{ ...row(),owner_user_id: assistant }],next_before: null },error: null })
    await expect(createAssistantWorkClient(transport,() => owner).list(assistant)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('discards a response after signout or account change', async () => {
    let current: string | null = owner
    const client = createAssistantWorkClient(async () => { current = null; return { data: { items: [row()],next_before: null },error: null } },() => current)
    await expect(client.list(assistant)).rejects.toMatchObject({ code: 'account-changed' })
  })

  it('preserves real read errors and never converts them to an empty task list', async () => {
    const client = createAssistantWorkClient(async () => ({ data: null,error: { code: '42501',message: 'Not authorized' } }),() => owner)
    await expect(client.listAll(assistant)).rejects.toMatchObject({ code: '42501' })
  })

  it('reads all cloud collaboration and retains unavailable source references without queue secrets', async () => {
    const first = event(), second = { ...event(),message_id: operation,seq: '3',source_available: false,content: null,
      source_chat_id: work,source_message_id: message,lease_token: operation }
    const transport = vi.fn().mockResolvedValueOnce({ data: { events: [first],next_after: '2' },error: null })
      .mockResolvedValueOnce({ data: { events: [second],next_after: null },error: null })
    const events = await createAssistantWorkClient(transport,() => owner).historyAll(assistant,work)
    expect(events.map(item => item.message_id)).toEqual([message,operation])
    expect(events[1]).toMatchObject({ content: null,source_available: false })
    expect(events[1]).not.toHaveProperty('lease_token')
    expect(transport.mock.calls[1]![1].p_after).toBe('2')
  })

  it('retains the original native session file receipt without manufacturing another upload', async () => {
    const file = { attachment_id: work,file_name: 'result.pdf',sha256: 'a'.repeat(64),size_bytes: 42,content_type: 'application/pdf' }
    const transport = async () => ({ data: { events: [{ ...event(),attachment_refs: [file] }],next_after: null },error: null })
    const records = await createAssistantWorkClient(transport,() => owner).historyAll(assistant,work)
    expect(records[0]!.attachment_refs).toEqual([file])
  })
})
