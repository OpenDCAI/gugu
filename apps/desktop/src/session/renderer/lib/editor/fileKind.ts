import type { ManagedFileKind } from './types';

/** Raster image extensions — rendered with <img>, not Monaco. */
export const RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp']);

/** HTML extensions — rendered with the HTML preview iframe. */
export const HTML_EXTS = new Set(['html', 'htm']);

/**
 * Known binary / non-text extensions — shown as "unsupported" instead of
 * attempting to load into Monaco.
 */
export const BINARY_EXTS = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'wasm',
  'zip',
  'tar',
  'gz',
  'bz2',
  '7z',
  'rar',
  'db',
  'sqlite',
  'sqlite3',
  'class',
  'jar',
  'pyc',
  'o',
  'a',
  'lib',
  'bin',
  'dat',
  'pkg',
  'dmg',
  'iso',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'avi',
  // #7191 老的二进制 Office 格式与 Pages / Numbers / OpenDocument:画不出来,交给系统默认程序。
  // ❌ 不进这张表的话它们会被当文本读,读出二进制再降级成占位卡 —— 而工作区外的附件靠这张表才知道该交给系统。
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  // ❌ 'key'(Keynote):`server.key` 这类 PEM 私钥是纯文本,同一个扩展名进这张表就再也打不开它们。
  // Keynote 文档本来多半是 macOS 的包目录,不是单个文件。
]);

/**
 * #7191 Office 文档(owner 2026-10-15:「咕咕里预览」)。渲染复用主 app 聊天附件那一份
 * `DocumentPreviewContent`:Word = docx-preview,PPT = @aiden0z/pptx-renderer,Excel = @silurus/ooxml。
 */
export const OFFICE_KINDS = { docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xlsm: 'xlsx' } as const;

/**
 * Determine the kind of a file purely from its extension, with no I/O.
 * Returns everything except `'too-large'`, which is set after reading the file
 * and checking the `truncated` flag from the FS layer.
 */
export function getFileKind(filePath: string): Exclude<ManagedFileKind, 'too-large'> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (RASTER_EXTS.has(ext)) return 'image';
  // PDF 有自己的渲染器(pdf.js,与主 app 聊天里那份文档预览同一份),❌ 不再和 .exe/.zip
  // 一起归进 binary —— 归错的代价是文件 tab 给它画一张「不支持的文件格式」占位卡(#5269)。
  if (ext === 'pdf') return 'pdf';
  if (Object.hasOwn(OFFICE_KINDS, ext)) return OFFICE_KINDS[ext as keyof typeof OFFICE_KINDS];
  if (ext === 'svg') return 'svg';
  if (ext === 'csv') return 'csv';
  if (ext === 'md' || ext === 'mdx') return 'markdown';
  if (HTML_EXTS.has(ext)) return 'html';
  if (BINARY_EXTS.has(ext)) return 'binary';
  return 'text';
}

/** True for file kinds that default to rendered/preview mode. */
export function isPreviewableKind(kind: ManagedFileKind): boolean {
  return kind === 'svg' || kind === 'markdown' || kind === 'html' || kind === 'csv';
}

/**
 * True for kinds whose renderer goes and fetches its own bytes(#5269)。
 *
 * ⚠️ 这条存在的理由:外部文件那条通用读取走的是 `readText`,读到二进制就调
 * `setExternalBinary()` —— 它会把 `contentType` **盖成 `binary`**,于是 PDF 刚判出来的类型
 * 当场被抹掉,界面回到「不支持的文件格式」。真机上就是这么翻的车。
 * ⇒ 自己取字节的那些类型,必须让通用读取绕开它们。
 *
 * 图片不在这里:它的渲染器不取字节,外部图片由那条通用读取改走 `readImage`
 * (`external-file-load.ts`,#6455)。把 image 加进来,外部图片就再没人去读了。
 */
export function isSelfLoadingKind(kind: ManagedFileKind): boolean {
  return kind === 'pdf' || isOfficeKind(kind);
}

/** Word / PPT / Excel:与 PDF 同样自己去取字节、只读预览,差异视图里按二进制处理。 */
export function isOfficeKind(kind: ManagedFileKind): kind is 'docx' | 'pptx' | 'xlsx' {
  return kind === 'docx' || kind === 'pptx' || kind === 'xlsx';
}

/** True for files backed by Monaco text models for source editing and saving. */
export function isMonacoBackedKind(kind: ManagedFileKind): boolean {
  return kind === 'text' || isPreviewableKind(kind);
}

/** True for files the diff viewer must not load into Monaco. */
export function isBinaryForDiff(filePath: string): boolean {
  const kind = getFileKind(filePath);
  return kind === 'binary' || kind === 'image' || kind === 'svg' || isOfficeKind(kind);
}

/** True for files the diff viewer renders as an `<img>` preview instead of text. */
export function isImageForDiff(filePath: string): boolean {
  const kind = getFileKind(filePath);
  return kind === 'image' || kind === 'svg';
}
