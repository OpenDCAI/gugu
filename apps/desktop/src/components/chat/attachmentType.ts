import { resolveAttachmentMimeType } from '@gugu/core/shared/imageMime.mjs'

const extensions: Record<string, string> = {
  pdf: 'pdf', doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', xlsm: 'excel',
  ppt: 'presentation', pptx: 'presentation', txt: 'text', md: 'markdown', mdx: 'markdown',
  csv: 'csv', html: 'html', htm: 'html', json: 'json', zip: 'archive',
}
const types: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'application/vnd.ms-excel': 'excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
  'application/vnd.ms-powerpoint': 'presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'presentation',
  'text/plain': 'text', 'text/markdown': 'markdown', 'text/csv': 'csv',
  'text/html': 'html', 'application/json': 'json',
  'application/zip': 'archive', 'application/x-zip-compressed': 'archive',
}

/** Unknown types have no label: a raw MIME string is transport metadata, not user-facing copy. */
export function attachmentTypeKey(file: { fileName: string; mimeType: string }): string | null {
  const mime = resolveAttachmentMimeType(file.fileName, file.mimeType.split(';')[0].trim().toLowerCase())
  const extension = file.fileName.toLowerCase().split('.').pop() ?? ''
  return types[mime] ?? extensions[extension] ?? (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : null)
}
