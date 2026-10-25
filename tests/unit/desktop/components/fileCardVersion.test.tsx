// @vitest-environment jsdom
// 附件卡片说出它钉住的是群文件夹里那个文件的第几版:第 1 版不写(大多数附件只有一版),之后写「第 N 版」。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAttachmentContent } from '../../../../packages/core/src/shared/ui/attachmentModels'
import { MediaAttachmentBubble } from '../../../../apps/desktop/src/components/chat/MediaAttachmentBubble'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { createNode, createReactHarness } from '../../../support/testHarness'

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const envelope = `[附件] deck.pptx (${PPTX})\n[Size] 2048\n[Kind] file`
const meta = (version: number) => parseAttachmentContent(envelope, { id: 'm1', file_item_id: '3f88423a-bbca-49f1-9d19-48bb6ee042a5', file_version: version, file_blob_id: null })!

let ui: ReturnType<typeof createReactHarness>
beforeEach(() => { ui = createReactHarness(); setLocalePreference('zh-CN') })
afterEach(() => ui.cleanup())

describe('a file card names the version it pins', () => {
  it('version 3: 第 3 版 before the size; version 1: just the size', async () => {
    await ui.render(createNode(MediaAttachmentBubble, { meta: meta(3), messageId: 'm1', isMine: false }))
    expect(ui.container.textContent).toContain('第 3 版 · 2.0 KB')
    await ui.render(createNode(MediaAttachmentBubble, { meta: meta(1), messageId: 'm1', isMine: false }))
    expect(ui.container.textContent).not.toContain('版')
    expect(ui.container.textContent).toContain('deck.pptx')
  })
})
