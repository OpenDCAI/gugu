import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectFilePublisher } from '../../../../apps/desktop/electron/projectFilePublication'
import { createNativeFileHost } from '../../../../apps/desktop/electron/nativeFileHost'
import { prepareChatAttachment, commitPreparedChatAttachment } from '../../../../apps/desktop/src/lib/attachmentsEndpoint'
import { i18n } from '../../../../apps/desktop/src/i18n'
const transport = vi.hoisted(() => ({ handoff: vi.fn(), upload: vi.fn(), commit: vi.fn() }))
vi.mock('@gugu/core/cloud/fileVersionHandoff', async original => ({
  ...await original<typeof import('@gugu/core/cloud/fileVersionHandoff')>(), handOffNextVersion: transport.handoff,
}))
vi.mock('@gugu/core/cloud/attachmentsApi', async original => ({
  ...await original<typeof import('@gugu/core/cloud/attachmentsApi')>(), uploadAttachmentBytes: transport.upload, commitAttachment: transport.commit,
}))
const endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'fixture' }
const scope = { chat_id: 'group', as: 'human' }
const message = { message_id: 'message', chat_id: 'group', sender_user_id: 'human', file_name: 'notes.md', thread_root_id: 'topic', to_user_ids: ['member'] }
const roots: string[] = []
async function fixture(pathBacked: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-composer-handoff-')); roots.push(root)
  const selected = new File(['notes'], 'notes.md', { type: 'text/markdown' }), path = join(root, selected.name)
  await writeFile(path, 'notes')
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'file_project_policy_for') return { host_device_id: 'host', host_project_id: 'project', proactive_upload: false }
    if (name === 'workspace_get_as') return [{ id: args.p_item_id, filename: 'notes (2).md', version: 1, chat_id: 'group' }]
    throw new Error(`Unexpected RPC ${name}`)
  })
  const publish = createProjectFilePublisher({ identity: async () => ({ accountId: 'human', deviceId: 'non-host' }),
    root: async () => null, rpc, env: { GUGU_HOME: root }, endpoint: async () => endpoint })
  const host = createNativeFileHost({ root, owner: async () => 'human', alive: () => true,
    publish: (chat, file, actor, message) => publish(chat, file, null, actor, undefined, { message }), publication: publish.local,
    local: async () => null, ssh: async () => null, openPath: async () => '', published: () => {} })
  const invoke = vi.fn(async (_channel: string, request: Parameters<typeof host.publish>[1]) => host.publish(1, request))
  vi.stubGlobal('window', { electronAPI: { invoke, getPathForFile: () => pathBacked ? path : '' } })
  transport.handoff.mockReset().mockResolvedValue({ status: 'published', version: 1, message_id: 'message' })
  transport.upload.mockReset().mockRejectedValue(new Error('Project files are not uploaded proactively'))
  transport.commit.mockReset()
  return { selected, path, rpc, invoke }
}
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    expect(root.startsWith(join(tmpdir(), 'gugu-composer-handoff-'))).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
describe('a non-host human composer uses the same project-file handoff as an agent', () => {
  it.each([true, false])('sends a picked/dragged file or pasted bytes through the native publisher (path: %s)', async pathBacked => {
    const f = await fixture(pathBacked)
    const prepared = await prepareChatAttachment(endpoint, f.selected, scope)
    expect(prepared).toEqual({ local: f.selected })
    expect(transport.handoff).not.toHaveBeenCalled()
    await expect(commitPreparedChatAttachment(endpoint, prepared, message)).resolves.toMatchObject({
      id: 'message', chat_id: 'group', sender_user_id: 'human', file_version: 1,
    })
    expect(transport.handoff).toHaveBeenCalledExactlyOnceWith(endpoint, expect.objectContaining({
      chatId: 'group', as: 'human', fileName: 'notes.md', bytes: new TextEncoder().encode('notes'),
      message: expect.objectContaining({ message_id: 'message', thread_root_id: 'topic', to_user_ids: ['member'] }),
    }))
    expect(transport.upload).not.toHaveBeenCalled(); expect(transport.commit).not.toHaveBeenCalled()
    expect(await readFile(f.path, 'utf8')).toBe('notes')
  })
  it.each(['en-US', 'zh-CN'])('surfaces the offline machine and retry advice in %s, keeping the original', async language => {
    const f = await fixture(true), previous = i18n.language
    await i18n.changeLanguage(language)
    try {
      const prepared = await prepareChatAttachment(endpoint, f.selected, scope)
      transport.handoff.mockResolvedValueOnce({ status: 'host_offline', host_label: 'Studio Mac' })
      const error = await commitPreparedChatAttachment(endpoint, prepared, message).catch(error => error) as Error
      expect(error.message).toContain('Studio Mac')
      expect(error.message).toMatch(language === 'en-US' ? /offline.*Send it again/ : /离线.*再发/)
      expect(error.message).not.toMatch(/files:publish|Next version|proactively/)
      expect(transport.upload).not.toHaveBeenCalled(); expect(transport.commit).not.toHaveBeenCalled()
      expect(await readFile(f.path, 'utf8')).toBe('notes')
    } finally { await i18n.changeLanguage(previous) }
  })
})
