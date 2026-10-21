import type { AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'

export type DocumentPreviewKind = 'text' | 'markdown' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'video' | 'unsupported'

const TEXT_EXTENSIONS = new Set(['css', 'js', 'jsx', 'json', 'md', 'mdx', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml', 'csv'])

export function classifyDocumentPreview(file: Pick<AttachmentMeta, 'fileName' | 'mimeType'>): DocumentPreviewKind {
  const mime = file.mimeType.toLowerCase().split(';', 1)[0].trim()
  const extension = file.fileName.toLowerCase().split('.').pop() ?? ''

  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === 'docx') return 'docx'
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || extension === 'pptx') return 'pptx'
  // #7191 Excel:`@silurus/ooxml` 渲染(带宏的 .xlsm 同是 OOXML 表格,一并认;老的二进制 .xls 不认,照旧交给系统应用)。
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel.sheet.macroenabled.12' || extension === 'xlsx' || extension === 'xlsm') return 'xlsx'
  if (mime === 'text/markdown' || extension === 'md' || extension === 'mdx') return 'markdown'
  if (mime === 'text/html' || extension === 'html' || extension === 'htm') return 'html'
  if (mime.startsWith('text/') || /json|javascript|xml|yaml|toml|csv/.test(mime) || TEXT_EXTENSIONS.has(extension)) return 'text'
  if (/^video\/(mp4|webm|quicktime)$/.test(mime) || /^(mp4|m4v|mov|webm)$/.test(extension)) return 'video' // 三个宿主都能直接播的容器;avi、mkv 照旧交给系统应用
  return 'unsupported'
}

export function documentPreviewNeedsFetch(kind: DocumentPreviewKind): boolean {
  return kind !== 'unsupported' && kind !== 'video' // 视频由 <video> 按需分段取,❌ 整段读进内存
}
