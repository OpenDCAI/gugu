import { afterEach, expect, it, vi } from 'vitest'
import { uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('bounds an unresponsive attachment request instead of leaving a panel upload or publication stuck', async () => {
  vi.stubEnv('GUGU_SUPABASE_URL','http://127.0.0.1:12345'); vi.stubEnv('GUGU_SUPABASE_ANON_KEY','fixture')
  vi.useFakeTimers()
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation((_url,init) => new Promise((_resolve,reject) => {
    init?.signal?.addEventListener('abort',() => reject(init.signal!.reason),{ once: true })
  }))
  let outcome = 'waiting'
  void uploadAssistantPanelBody({ ownerId: 'owner',accountId: () => 'owner',token: 'fixture',chatId: 'chat',label: 'note.md',
    bytes: new TextEncoder().encode('note') }).then(() => { outcome = 'saved' },() => { outcome = 'failed' })
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(30_001)
  expect(outcome).toBe('failed')
})

// #591: the attachment service classifies every upload with workspaceUploadKind (it imports this very module). A body
// whose name or declared type said text (a memory .md, an integration's JSON) came back as a document and failed
// verification; which bodies did depended on the service's deployed rule. What a body sends must classify as a file.
it.each([
  ['a memory note', 'note.md', '# Title\n\nplain UTF-8 text'],
  ['an integration account', '["dingtalk","default"]', JSON.stringify({ providerId: 'dingtalk',name: 'Example' })],
  ['an integration catalog entry', 'catalog:mail', JSON.stringify({ version: 1,en: { name: 'Mail' } })],
  ['a skill', 'SKILL.md', 'text'],
])('uploads %s as bytes the attachment service stores as a file', async (_case,label,text) => {
  vi.stubEnv('GUGU_SUPABASE_URL','http://127.0.0.1:12345'); vi.stubEnv('GUGU_SUPABASE_ANON_KEY','fixture')
  const sent: { declared: unknown[]; names: unknown[] } = { declared: [],names: [] }
  vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init) => {
    const path = String(url)
    if (path.endsWith('/attachments/upload')) {
      sent.declared.push(JSON.parse(String(init?.body)).content_type)
      return Response.json({ staging_key: 'staging',url: 'http://127.0.0.1:12345/store',fields: {},max_bytes: 4096 })
    }
    if (path.endsWith('/store')) {
      const file = (init?.body as FormData).get('file') as File
      sent.names.push(file.name); sent.declared.push(file.type)
      return new Response(null,{ status: 204 })
    }
    if (path.endsWith('/attachments/place')) {
      const body = JSON.parse(String(init?.body))
      sent.names.push(body.file_name); sent.declared.push(body.content_type)
      return Response.json({ item: { id: 'stored-body',kind: 'file' } })
    }
    throw new Error('Unexpected request')
  })
  const bytes = new TextEncoder().encode(text)
  await uploadAssistantPanelBody({ ownerId: 'owner',accountId: () => 'owner',token: 'fixture',chatId: 'chat',label,bytes })

  expect(sent.names).toHaveLength(2); expect(sent.declared).toHaveLength(3)
  for (const name of sent.names) for (const type of sent.declared) {
    expect(workspaceUploadKind(String(name),String(type),bytes)).toMatchObject({ kind: 'file' })
  }
  // The control: what the publisher declared before this fix is a document under the same rule.
  const before = label === 'note.md' || label === 'SKILL.md' ? ['note.md','text/plain'] : [`${label}.bin`,'application/json']
  expect(workspaceUploadKind(before[0],before[1],bytes)).toMatchObject({ kind: 'document' })
})
