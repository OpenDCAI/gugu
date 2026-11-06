// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { followLink, openTarget } from '../../../../apps/desktop/src/lib/guguLinks'

const state = vi.hoisted(() => ({ open: vi.fn(), metadata: vi.fn(), notice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpc: { extensions: { openLink: state.open } } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ fileMetadata: state.metadata }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: state.notice }))

const target = { kind: 'file' as const, itemId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 3 }
const failed = { kind: 'failed', name: 'file', reason: 'unavailable', detail: '这条关联消息已删除或当前无法访问 /Users/test/private' }

beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('zh-CN')
  state.open.mockResolvedValue(failed)
  state.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object' } })
})

describe('file-link failure notices', () => {
  it('names the offline file-holding computer without a protocol or message prefix', async () => {
    state.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'local', host_online: false } })
    await expect(openTarget(target)).rejects.toThrow(/^存放这个文件的电脑当前离线，请等电脑上线后再试$/)
    expect(state.metadata).toHaveBeenCalledExactlyOnceWith(target.itemId, 3)
  })

  it.each(['gone', 'expired', 'missing'])('uses the missing-file wording only after confirmed %s metadata', async status => {
    state.metadata.mockResolvedValue({ status, sha256: null })
    await expect(openTarget(target)).rejects.toThrow(/^这个文件已删除或无法访问$/)
  })

  it.each([true, undefined])('keeps an unknown or online holder failure distinct from a deleted file (%s)', async online => {
    state.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'local', host_online: online } })
    await expect(openTarget(target)).rejects.toThrow(/^暂时打不开这个文件，请稍后重试$/)
  })

  it('does not turn a metadata transport failure into a deleted-file claim or expose raw error details', async () => {
    state.metadata.mockRejectedValue(new Error('file: private transport error /Users/test/private'))
    await expect(openTarget(target)).rejects.toThrow(/^暂时打不开这个文件，请稍后重试$/)
  })

  it('keeps a synchronous signed-out metadata refusal behind the generic file notice', async () => {
    state.metadata.mockImplementation(() => { throw new Error('File reader is not signed in') })
    await expect(openTarget(target)).rejects.toThrow(/^暂时打不开这个文件，请稍后重试$/)
  })

  it('also classifies a rejected open RPC instead of exposing its internal failure', async () => {
    state.open.mockRejectedValue(new Error('file: connection closed /Users/test/private'))
    state.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'local', host_online: false } })
    await expect(openTarget(target)).rejects.toThrow(/^存放这个文件的电脑当前离线，请等电脑上线后再试$/)
  })

  it('shows one file-specific notice for a normal followed file link', async () => {
    state.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'local', host_online: false } })
    expect(followLink(target)).toBe(true)
    await vi.waitFor(() => expect(state.notice).toHaveBeenCalledExactlyOnceWith({
      tier: 'error', title: '存放这个文件的电脑当前离线，请等电脑上线后再试',
    }))
  })

  it('does not add a metadata read to successful opens', async () => {
    state.open.mockResolvedValue({ kind: 'opened' })
    await expect(openTarget(target)).resolves.toBe(true)
    expect(state.metadata).not.toHaveBeenCalled()
  })

  it('preserves existing non-file link failures', async () => {
    state.open.mockResolvedValue({ kind: 'failed', name: 'project', detail: 'Existing project error' })
    await expect(openTarget({ kind: 'project', projectId: 'project' })).rejects.toThrow('project: Existing project error')
    expect(state.metadata).not.toHaveBeenCalled()
  })
})
