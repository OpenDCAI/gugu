// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead'

const fixture = vi.hoisted(() => ({ result: { data: null,error: { code: 'ENOTFOUND',message: 'private network detail' },status: 0 } }))
vi.mock('@/lib/supabase',() => ({ identityDb: { rpc: () => ({ abortSignal: async () => fixture.result }),from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ abortSignal: async () => fixture.result }) }) }) }) },chatDb: { rpc: () => ({ abortSignal: async () => fixture.result }) } }))
vi.mock('@/lib/sessionPublication',() => ({ getRendererSession: () => ({ user: { id: 'owner' } }),observeRendererSession: () => () => {} }))
vi.mock('@/lib/log',() => ({ rendererLogger: () => ({ warn: vi.fn() }) }))
const { assistantPanelCloud,personalAssistant,assistantPrivateChat } = await import('../../../../apps/desktop/src/components/assistant/assistant-panel-cloud')
afterEach(() => window.localStorage.clear())

it.each([[0,'ENOTFOUND',true],[0,'ECONNRESET',true],[503,'gateway_unavailable',true],[500,'54000',false],[400,'22023',false]] as const)('keeps RPC status %s with code %s across the shell cloud adapter', async (status,code,retry) => {
  fixture.result = { data: null,error: { code,message: 'private network detail' },status }
  const error = await assistantPanelCloud.snapshot('assistant').catch(error => error)
  expect(error).toMatchObject({ code,status })
  expect(isAssistantPanelReadRetryable(error)).toBe(retry)
})

it.each([[0,'ENOTFOUND'],[503,'gateway_unavailable']] as const)('preserves transient identity read status %s', async (status,code) => {
  fixture.result = { data: null,error: { code,message: 'private network detail' },status }
  for (const read of [() => personalAssistant('owner'),() => assistantPrivateChat('owner','assistant')]) {
    const error = await read().catch(error => error)
    expect(error).toMatchObject({ code,status })
    expect(isAssistantPanelReadRetryable(error)).toBe(true)
  }
})
