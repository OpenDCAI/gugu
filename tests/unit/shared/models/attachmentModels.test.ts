import { describe, expect, it } from 'vitest'
import {
  formatAttachmentMetadata,
  formatLegacyAttachmentContent,
  formatAttachmentSize,
  inferAttachmentKind,
  parseAttachmentContent,
} from '@gugu/core/shared/ui/attachmentModels'

describe('attachment models', () => {
  it('formats and parses attachment metadata content', () => {
    const content = formatAttachmentMetadata({
      kind: 'image',
      fileName: ' photo.png ',
      mimeType: 'image/png',
      url: ' https://example.com/photo.png ',
      sizeBytes: 42.4,
    })

    expect(content).toBe('[附件] photo.png (image/png)\n[URL] https://example.com/photo.png\n[Size] 42\n[Kind] image')
    expect(parseAttachmentContent(content)).toEqual({
      kind: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 42,
      source: { kind: 'url', url: 'https://example.com/photo.png' },
    })
  })

  // 新式(attachments/commit 发的):正文是 gugu-supabase chat.attachment_envelope 写的,没有 [URL];字节由行上两列指着。
  it('reads the folder-backed envelope by the row\'s file pointer; no pointer = the file was deleted', () => {
    const envelope = '[附件] shot.png (image/png)\n[Size] 2048\n[Kind] image'
    const parsed = parseAttachmentContent(envelope, { file_item_id: 'item-1', file_version: 3 })
    expect(parsed).toEqual({ kind: 'image', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, source: { kind: 'item', itemId: 'item-1', version: 3 } })
    expect(parseAttachmentContent(envelope, { file_item_id: null, file_version: 3 })?.source).toEqual({ kind: 'gone' })
    expect(parseAttachmentContent(envelope)?.source).toEqual({ kind: 'gone' })
    expect(parseAttachmentContent(envelope, { file_item_id: 'item-1', file_version: 0 })?.source).toEqual({ kind: 'gone' })
    // 悄悄话的附件:消息直接指字节 ⇒ 按这条消息签;没有消息 id 认不出是哪条,算不上来源。
    expect(parseAttachmentContent(envelope, { id: 'msg-1', file_blob_id: 'blob-1' })?.source).toEqual({ kind: 'message', messageId: 'msg-1' })
    expect(parseAttachmentContent(envelope, { file_blob_id: 'blob-1' })?.source).toEqual({ kind: 'gone' })
    // 老正文不看指针;既没有 [URL] 也没有 [Size] / [Kind] 的不是附件。
    expect(parseAttachmentContent('[附件] a.png (image/png)\n[URL] https://x/a.png\n[Size] 1\n[Kind] image', { file_item_id: 'item-1', file_version: 1 })?.source).toEqual({ kind: 'url', url: 'https://x/a.png' })
    expect(parseAttachmentContent('[附件] notes.txt\nhello there', { file_item_id: 'item-1', file_version: 1 })).toBeNull()
    expect(parseAttachmentContent('[附件] 语音.webm (audio/webm)\n[语音] durationMs=1200\n[转写] 你好')).toBeNull()
  })

  it('keeps an image caption in the same canonical attachment message', () => {
    const content = formatAttachmentMetadata({
      kind: 'image', fileName: 'photo.jpg', mimeType: 'image/jpeg',
      url: 'http://127.0.0.1:55321/photo.jpg', sizeBytes: 10, caption: 'hello\nworld',
    })
    expect(content).toContain('[Kind] image\n[Caption]\nhello\nworld')
    expect(parseAttachmentContent(content)?.caption).toBe('hello\nworld')
  })

  it.each([
    ['formatAttachmentSize', () => formatAttachmentSize(512), '512 B'],
    ['formatAttachmentSize', () => formatAttachmentSize(1536), '1.5 KB'],
    ['inferAttachmentKind', () => inferAttachmentKind({ type: 'image/jpeg' }), 'image'],
    ['inferAttachmentKind', () => inferAttachmentKind({ type: 'application/pdf' }), 'file'],
  ])('%s keeps its canonical compact output', (_name, read, expected) => {
    expect(read()).toBe(expected)
  })

  it.each([
    ['photo.png', 'image/png', 'caption', '[附件] photo.png (image/png)\ncaption'],
    ['notes.txt', '', '', '[附件] notes.txt'],
  ])('preserves the legacy wire format for %s', (fileName, mimeType, caption, expected) => {
    expect(formatLegacyAttachmentContent(fileName, mimeType, caption)).toBe(expected)
  })
})
