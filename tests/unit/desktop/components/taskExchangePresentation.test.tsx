// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { withSessionAttachments } from '@gugu/core/cloud/sessionAttachments'
import { attachmentFileRef } from '@gugu/core/shared/ui/attachmentModels'
import { taskExchangeContent } from '../../../../apps/desktop/src/components/assistant/taskExchangeContent'
import { TaskExchangeBubble } from '../../../../apps/desktop/src/components/assistant/TaskExchangeBubble'
import { FileAttachmentCard } from '../../../../apps/desktop/src/components/chat/FileAttachmentCard'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { clickElement, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const reads = vi.hoisted(() => ({ metadata: vi.fn(), download: vi.fn() }))
vi.mock('@/lib/attachmentBytes', async original => ({ ...await original<object>(), attachmentMetadata: reads.metadata, downloadAttachment: reads.download }))
const ref = { attachment_id: '11111111-1111-4111-8111-111111111111', file_name: 'report.xlsx', sha256: 'ab'.repeat(32), size_bytes: 2048,
  content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
const report = '\n<gugu_work_result>\n{"work_id":"22222222-2222-4222-8222-222222222222","status":"completed"}\n</gugu_work_result>'
const raw = withSessionAttachments('计算完成，附件在这里。', [ref]) + report
let ui: ReturnType<typeof createReactHarness>
beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  ui = createReactHarness(); setLocalePreference('zh-CN'); attachmentQueryClient.clear(); vi.clearAllMocks()
  reads.metadata.mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', ...ref } })
  reads.download.mockResolvedValue(undefined)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]) }
    disconnect() {}
  })
})
afterEach(() => { notifyManager.setScheduler(callback => setTimeout(callback, 0)); ui.cleanup(); attachmentQueryClient.clear(); vi.unstubAllGlobals() })

describe('task collaboration presentation', () => {
  it('understands the real producer format while leaving the original message untouched', () => {
    const displayed = taskExchangeContent(raw)
    expect(displayed.text).toBe('计算完成，附件在这里。')
    expect(displayed.files).toHaveLength(1)
    expect(attachmentFileRef(displayed.files[0]!.source)).toEqual({ attachment_id: ref.attachment_id })
    expect(raw).toContain(ref.sha256)
    expect(raw).toContain('<gugu_work_result>')
  })
  it('also hides the dispatch work protocol without discarding the actual instructions', () => {
    const raw = 'Make the spreadsheet.\n\n<gugu_work>\n{"work_id":"work-id","report":"session_message work_result=..."}\n</gugu_work>'
    expect(taskExchangeContent(raw).text).toBe('Make the spreadsheet.')
  })
  it('does not interpret inline mentions or fenced protocol examples', () => {
    for (const text of ['Explain <gugu_work_result> in this document.', '```\n' + raw + '\n```', 'Do not change 附件（原件引用与校验信息；仅元数据）：[]']) {
      expect(taskExchangeContent(text)).toEqual({ text, files: [], invalidAttachments: false })
    }
  })
  it('hides work-result-only messages and preserves ordinary text', () => {
    expect(taskExchangeContent(report.trim()).text).toBe('')
    expect(taskExchangeContent('done' + report)).toEqual({ text: 'done', files: [], invalidAttachments: false })
  })
  it.each(['[{"attachment_id":"bad"}]', '[invalid json]', '{}'])('shows a readable error for malformed references, without printing the protocol (%s)', refs => {
    const result = taskExchangeContent('done\n\n附件（原件引用与校验信息；仅元数据）：\n' + refs + report)
    expect(result).toEqual({ text: 'done', files: [], invalidAttachments: true })
  })
  it('does not mistake protocol-looking text in a filename for a new block', () => {
    const named = { ...ref, file_name: '附件（原件引用与校验信息；仅元数据）：.txt' }
    expect(taskExchangeContent(withSessionAttachments('file', [named])).files[0]?.fileName).toBe(named.file_name)
  })
  it('does not offer IM re-upload actions for an expired session attachment sent by the assistant', async () => {
    reads.metadata.mockResolvedValue({ status: 'expired', sha256: ref.sha256 })
    await renderWithAppProviders(ui, <TaskExchangeBubble message={message({ content: raw, is_mine: true })} recipientUserId="task" mobile={false} />, { contacts: { contacts: [] } })
    await act(async () => {})
    expect(ui.container.textContent).toContain('文件已过期')
    expect(ui.container.textContent).not.toContain('重新上传')
    expect(reads.download).not.toHaveBeenCalled()
  })
  it('keeps multiple file references as distinct canonical capabilities', () => {
    const refs = [ref, { ...ref, attachment_id: '33333333-3333-4333-8333-333333333333', file_name: 'second.txt', content_type: 'text/plain' }]
    expect(taskExchangeContent(withSessionAttachments('two files', refs)).files.map(file => attachmentFileRef(file.source))).toEqual(refs.map(file => ({ attachment_id: file.attachment_id })))
  })
  it.each([false, true])('renders real file cards on mobile=%s, opens the normal preview, and downloads without success alerts', async mobile => {
    const original = Object.freeze(message({ content: raw, sender_user_id: 'task', is_mine: false }))
    const open = vi.fn(), toast = vi.fn()
    await renderWithAppProviders(ui, <TaskExchangeBubble message={original} recipientUserId="assistant" mobile={mobile} onOpenFile={open} />, { contacts: { contacts: [] }, toast })
    await act(async () => {})
    const text = ui.container.textContent!
    expect(text).toContain('计算完成'); expect(text).toContain('report.xlsx'); expect(text).toContain('Excel 表格')
    for (const hidden of ['gugu_work_result', 'attachment_id', ref.sha256, ref.content_type, '仅元数据']) expect(text).not.toContain(hidden)
    const buttons = Array.from(ui.container.querySelectorAll('button'))
    await clickElement(buttons.find(button => button.getAttribute('aria-label') === 'report.xlsx')!)
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'report.xlsx', source: { kind: 'attachment', attachmentId: ref.attachment_id } }))
    await clickElement(buttons.find(button => button.getAttribute('aria-label') === '下载')!)
    expect(reads.download).toHaveBeenCalledWith({ kind: 'attachment', attachmentId: ref.attachment_id }, 'report.xlsx')
    expect(original.content).toBe(raw); expect(toast).not.toHaveBeenCalled(); expect(ui.container.querySelector('[role="alert"]')).toBeNull()
  })
  it('reports a real download failure inline', async () => {
    reads.download.mockRejectedValue(new Error('not allowed'))
    await renderWithAppProviders(ui, <TaskExchangeBubble message={message({ content: raw })} recipientUserId="assistant" mobile={false} />, { contacts: { contacts: [] } })
    await clickElement(ui.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!)
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe('无法下载文件')
  })
  it.each([
    ['table.xlsx', ref.content_type, 'Excel 表格'], ['notes.txt', 'text/plain; charset=UTF-8', '文本'],
    ['table.xlsx', 'application/octet-stream', 'Excel 表格'], ['unknown.xyz', 'application/x-unknown', null],
  ])('humanizes %s without leaking MIME metadata', async (fileName, mimeType, expected) => {
    await ui.render(<FileAttachmentCard file={{ fileName, mimeType, sizeBytes: 2048 }} onOpen={() => {}} />)
    expect(ui.container.textContent).toContain('2.0 KB')
    if (expected) expect(ui.container.textContent).toContain(expected)
    expect(ui.container.textContent).not.toContain(mimeType)
    if (!expected) expect(ui.container.textContent).toBe('unknown.xyz2.0 KB')
  })
})
