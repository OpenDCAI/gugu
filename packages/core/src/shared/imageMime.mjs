// @@@image-mime - 附件「是不是图、能不能内联画」的唯一判据,MCP 服务端(node .mjs)与渲染端共用。
// 判据取 mime 与扩展名的并集:agent 调 message_send_file 时 mime_type 可选、大小写随意,
// 只看 mime 会让同一张 .png 时而成图时而成文件卡片。
// 文件名说它是什么也只这一张表:附件、agent 传进工作区的文件、App 传的文件(app-files-core contentTypeOf)都查它。

const MIME_BY_EXT = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cc: 'text/x-c++',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  sql: 'text/x-sql',
  css: 'text/css',
  scss: 'text/x-scss',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  ini: 'text/plain',
  conf: 'text/plain',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

// Chromium <img> 解不了 heic/heif/tiff:它们仍是图片,但只能按文件卡片展示。
const NON_RENDERABLE_IMAGE_MIMES = new Set(['image/heic', 'image/heif', 'image/tiff'])

/** A file name's suffix, without its dot, lowercased; `''` without one. */
export function extensionOf(fileName) {
  const name = String(fileName ?? '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).trim().toLowerCase() : ''
}

export function normalizeMimeType(mimeType) {
  return String(mimeType ?? '').split(';')[0].trim().toLowerCase()
}

/** What a file's name says it is, or `null` when the table does not know its suffix. */
export function mimeTypeFromName(fileName) {
  return MIME_BY_EXT[extensionOf(fileName)] ?? null
}

/** The table's first extension for a content type, or null when its type is unknown. */
export function extensionFromMimeType(mimeType) {
  const type = normalizeMimeType(mimeType)
  return Object.keys(MIME_BY_EXT).find(extension => MIME_BY_EXT[extension] === type) ?? null
}

/** 扩展包(`.guguext`,#6646):聊天里画成扩展卡片;浏览器对这个后缀报空 type,只能按名补。 */
export const EXTENSION_ARCHIVE_MIME = 'application/vnd.gugu.extension+zip'

/** 声明的 mime 缺失或是泛二进制时,按扩展名补;否则保留声明值(小写化)。 */
export function resolveAttachmentMimeType(fileName, declaredMimeType) {
  const declared = normalizeMimeType(declaredMimeType)
  if (declared && declared !== 'application/octet-stream') return declared
  if (extensionOf(fileName) === 'guguext') return EXTENSION_ARCHIVE_MIME
  return mimeTypeFromName(fileName) ?? (declared || 'application/octet-stream')
}

export function isImageMimeType(mimeType) {
  return normalizeMimeType(mimeType).startsWith('image/')
}

export function isRenderableImage(fileName, mimeType) {
  const mime = resolveAttachmentMimeType(fileName, mimeType)
  return mime.startsWith('image/') && !NON_RENDERABLE_IMAGE_MIMES.has(mime)
}
