import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMessagingCatalog'

vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => 'https://db.test', getSupabaseAnonKey: () => 'anon' }))
// The data clients carry no auth session of their own (accessToken option): asking one for its session throws. The
// token is the one the session coordinator published — the same one every data request uses.
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { auth: { getSession: () => { throw new Error('Supabase Client is configured with the accessToken option') } } },
}))

const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')
const { attachmentsEndpoint, prepareChatAttachment, commitPreparedChatAttachment } = await import('../../../../apps/desktop/src/lib/attachmentsEndpoint')
afterEach(() => vi.unstubAllGlobals())

describe('attachmentsEndpoint: the attachments function, with the token the session coordinator published', () => {
  it.each(['missing', 'changed', 'denied'] as const)('passes a structured %s refusal through IPC with localized actionable copy', async reason => {
    const invoke = vi.fn(async () => ({ refused: reason }))
    vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: vi.fn(() => { throw new Error('restored paths must not consume a File') }) } })
    const previous = i18n.language
    const expected = { missing: ['The original file was moved or deleted.', '原文件已移动或删除'],
      changed: ['The original file has changed.', '原文件已修改'], denied: ['permission was denied', '没有读取原文件的权限'] }
    try {
      for (const [index, locale] of (['en-US', 'zh-CN'] as const).entries()) {
        await i18n.changeLanguage(locale)
        const failure = await commitPreparedChatAttachment({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' },
          { local: { path: '/original/a.txt', name: 'a.txt', size: 3, contentType: 'text/plain', lastModified: 123 }, itemId: 'stable-item' },
          { message_id: 'message', chat_id: 'chat', sender_user_id: 'owner', file_name: 'a.txt' }).catch(error => error)
        expect(failure.message).toContain(expected[reason][index])
        expect(failure.message).toContain(index ? '请重新选择文件' : 'Select the file again')
      }
      expect(invoke).toHaveBeenLastCalledWith('files:publish', expect.objectContaining({ itemId: 'stable-item', file: {
        path: '/original/a.txt', name: 'a.txt', size: 3, contentType: 'text/plain', lastModified: 123,
      } }))
    } finally { await i18n.changeLanguage(previous) }
  })
  it('signed out ⇒ said; signed in ⇒ that token, this build\'s server', async () => {
    await expect(attachmentsEndpoint()).rejects.toThrow(/not signed in/)
    publishRendererSession('SIGNED_IN', { access_token: 'published-token', user: { id: 'u1' } } as never)
    await expect(attachmentsEndpoint()).resolves.toEqual({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'published-token' })
  })
  it.each(['planning', 'commit'])('native %s failures expose product copy rather than raw IPC or disk errors', async stage => {
    const invoke = vi.fn(async () => { throw new Error("Error invoking remote method 'files:publish': EACCES /private/source") })
    vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: () => '/private/source' } })
    const file = new File(['bytes'], 'file.bin'), endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }
    const failure = await (stage === 'planning' ? prepareChatAttachment(endpoint, file, { chat_id: 'chat', as: 'owner' })
      : commitPreparedChatAttachment(endpoint, { local: file }, { message_id: 'message', chat_id: 'chat', sender_user_id: 'owner', file_name: file.name, content_type: 'application/octet-stream' }))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' }))
    expect((failure as Error).message).not.toMatch(/invoke|files:publish|EACCES|\/private\//)
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('a pasted file (no disk path) travels to main as bytes; a file with a path still travels as a path only', async () => {
    const row = { id: 'item', version: 1, message: { id: 'message', sender_user_id: 'owner', chat_id: 'chat', file_item_id: 'item', file_version: 1 } }
    const invoke = vi.fn(async () => row), path = vi.fn(() => '')
    vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: path } })
    const file = new File(['bytes'], 'image.png', { type: 'image/png' }), endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }
    const args = { message_id: 'message', chat_id: 'chat', sender_user_id: 'owner', file_name: file.name, content_type: 'image/png' }
    await commitPreparedChatAttachment(endpoint, { local: file }, args)
    const [, sent] = invoke.mock.calls[0] as unknown as [string, { file: { path: string; size: number; data?: ArrayBuffer } }]
    expect(sent.file).toMatchObject({ path: '', size: 5 })
    expect(new TextDecoder().decode(sent.file.data)).toBe('bytes')
    path.mockReturnValue('/Users/me/image.png')
    await commitPreparedChatAttachment(endpoint, { local: file }, args)
    const [, second] = invoke.mock.calls[1] as unknown as [string, { file: Record<string, unknown> }]
    expect(second.file).toMatchObject({ path: '/Users/me/image.png' }); expect(second.file).not.toHaveProperty('data')
  })
})
