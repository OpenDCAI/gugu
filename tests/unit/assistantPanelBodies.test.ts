import { afterEach, expect, it, vi } from 'vitest'
import { uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('bounds an unresponsive attachment request instead of leaving a panel upload or publication stuck', async () => {
  vi.stubEnv('GUGU_SUPABASE_URL','http://127.0.0.1:12345'); vi.stubEnv('GUGU_SUPABASE_ANON_KEY','fixture')
  vi.useFakeTimers()
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation((_url,init) => new Promise((_resolve,reject) => {
    init?.signal?.addEventListener('abort',() => reject(init.signal!.reason),{ once: true })
  }))
  let outcome = 'waiting'
  void uploadAssistantPanelBody({ ownerId: 'owner',accountId: () => 'owner',token: 'fixture',chatId: 'chat',name: 'note.md',
    bytes: new TextEncoder().encode('note'),contentType: 'text/plain' }).then(() => { outcome = 'saved' },() => { outcome = 'failed' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(30_001)
  expect(outcome).toBe('failed')
})
