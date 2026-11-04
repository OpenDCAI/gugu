import { describe, expect, it } from 'vitest'
import {
  isImageMimeType,
  isRenderableImage,
  mimeTypeFromName,
  resolveAttachmentMimeType,
} from '../../../../packages/core/src/shared/imageMime.mjs'
import { inferAttachmentKind } from '../../../../packages/core/src/shared/ui/attachmentModels'

// 「PNG 有时渲染有时不渲染」:agent 发文件时 mime_type 可选、大小写随意,判据必须是 mime ∪ 扩展名。
describe('image mime resolution', () => {
  it('fills a missing or generic mime from the extension, case-insensitively', () => {
    expect(resolveAttachmentMimeType('chart.png', undefined)).toBe('image/png')
    expect(resolveAttachmentMimeType('CHART.PNG', '')).toBe('image/png')
    expect(resolveAttachmentMimeType('photo.jpeg', 'application/octet-stream')).toBe('image/jpeg')
    expect(resolveAttachmentMimeType('notes.bin', undefined)).toBe('application/octet-stream')
    // #6646 扩展包:浏览器报空 type,按后缀补成扩展包的 mime,且不当图片。
    expect(resolveAttachmentMimeType('notes-1.0.0.GUGUEXT', '')).toBe('application/vnd.gugu.extension+zip')
    expect(isRenderableImage('notes-1.0.0.guguext', 'application/octet-stream')).toBe(false)
  })
  it('keeps a declared mime but normalizes its case and parameters', () => {
    expect(resolveAttachmentMimeType('x', 'Image/PNG')).toBe('image/png')
    expect(resolveAttachmentMimeType('a.pdf', 'application/pdf; charset=binary')).toBe('application/pdf')
    expect(isImageMimeType('IMAGE/WEBP')).toBe(true)
  })
  it('treats heic/tiff as images that Chromium cannot draw inline', () => {
    expect(mimeTypeFromName('IMG_1.HEIC')).toBe('image/heic')
    expect(isRenderableImage('IMG_1.HEIC', '')).toBe(false)
    expect(isRenderableImage('scan.tiff', 'image/tiff')).toBe(false)
    expect(isRenderableImage('shot.png', '')).toBe(true)
    // 历史消息:agent 没带 mime 发的 PNG 被记成 file + octet-stream,渲染端据扩展名自愈。
    expect(isRenderableImage('shot.png', 'application/octet-stream')).toBe(true)
  })
  it('classifies a browser File with an empty type by its name', () => {
    expect(inferAttachmentKind({ name: 'drag.png', type: '' })).toBe('image')
    expect(inferAttachmentKind({ name: 'README', type: '' })).toBe('file')
  })
  // 10-07 #6973:agent 不带 mime_type 传进工作区的 .mp4 落成 octet-stream,App 拿到的 Blob 类型就错了。一张表:App 的
  // contentTypeOf 也查它。
  it('fills video, audio and documents from the same table, and none of them is an image', () => {
    expect(resolveAttachmentMimeType('clip.mp4', undefined)).toBe('video/mp4')
    expect(resolveAttachmentMimeType('take.MOV', 'application/octet-stream')).toBe('video/quicktime')
    expect(resolveAttachmentMimeType('vo.mp3', '')).toBe('audio/mpeg')
    expect(resolveAttachmentMimeType('brief.md', '')).toBe('text/markdown')
    expect(mimeTypeFromName('server.ts')).toBe('text/typescript')
    expect(mimeTypeFromName('board.json')).toBe('application/json')
    expect(mimeTypeFromName('notes.bin')).toBeNull()
    expect(inferAttachmentKind({ name: 'clip.mp4', type: '' })).toBe('file')
  })
  // 10-15 #7263:聊天里发来的 HTML 在 `chat-media` 桶里落成 application/octet-stream,浏览器直接开那个 public
  // URL 就只当二进制/文本,下载到本地再打开才渲染。同 #6646(`.guguext`)、#6973(`.mp4`)一格:表里漏了 html,
  // 补上之后按后缀回落的上传路径(桌面 composer、agent 的 message_send_file)才会写 text/html。
  it('names an HTML attachment text/html from its suffix', () => {
    expect(resolveAttachmentMimeType('report.html', '')).toBe('text/html')
    expect(resolveAttachmentMimeType('REPORT.HTM', 'application/octet-stream')).toBe('text/html')
    expect(mimeTypeFromName('报告.html')).toBe('text/html')
    // 还不是图片:HTML 附件照旧画成文件卡片。
    expect(inferAttachmentKind({ name: 'report.html', type: '' })).toBe('file')
    // 声明的类型说了就算 —— 显式的 text/plain 不被后缀抢走。
    expect(resolveAttachmentMimeType('report.html', 'text/plain')).toBe('text/plain')
  })
})
