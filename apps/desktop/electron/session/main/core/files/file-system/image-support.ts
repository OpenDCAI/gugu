import path from 'node:path';
import type { IFileSystem } from '@gugu/session-core/files';
import { ok } from '@gugu/session-shared';
import { fileErrorToMessage } from './file-errors';

export const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * 能直接嵌进界面里读的二进制:图片,加上 PDF(#5269)。
 *
 * ⚠️ PDF 从前被归进 `fileKind.ts` 的 `BINARY_EXTS`,和 `.exe`/`.zip` 并排 —— 于是文件 tab 给它
 * 画一张「不支持的文件格式」占位卡。owner 2026-09-10:「按理说应该原生支持 pdf 等文件阅读来着」。
 * 渲染那一半复用主 app 早就在用的 pdf.js(`DocumentPreviewContent`),这里只负责把字节递上去。
 *
 * Word / PPT / Excel 同理(#7191,owner 2026-10-15「咕咕里预览」):渲染是 docx-preview / pptx-renderer /
 * @silurus/ooxml,这里同样只递字节。❌ 曾经漏了这一格 —— 渲染层认得 .xlsx,这里却回一句
 * 「Unsupported inline format」,文件页签只剩一行英文报错(真机点开才看得见,单测碰不到这一层)。
 *
 * ❌ 别把这份名单当成「什么文件能打开」的通用判据:它只回答「这些字节能不能整块塞进一个
 * data URL 交给渲染层」。上限 10MB 就是为这件事定的。
 */
const INLINE_MIME_TYPES: Record<string, string> = {
  ...IMAGE_MIME_TYPES,
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
};

/**
 * 把一份文件读成 data URL。与 `readWorkspaceImage` 同一套上限与错误形状,只是名单更宽一格。
 */
export async function readInlineBinaryDataUrl(fileSystem: IFileSystem, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = INLINE_MIME_TYPES[ext];
  if (!mimeType) {
    return ok({
      success: false as const,
      error: `Unsupported inline format: ${ext}. Allowed: ${Object.keys(INLINE_MIME_TYPES).join(', ')}`,
    });
  }

  const result = await fileSystem.readBytes(filePath, { maxBytes: MAX_IMAGE_SIZE });
  if (!result.success) {
    return ok({ success: false as const, error: fileErrorToMessage(result.error) });
  }
  if (result.data.truncated) {
    return ok({
      success: false as const,
      error: `File too large: ${result.data.totalSize} bytes (max ${MAX_IMAGE_SIZE})`,
    });
  }

  const base64 = Buffer.from(result.data.bytes).toString('base64');
  return ok({ success: true as const, dataUrl: `data:${mimeType};base64,${base64}`, mimeType });
}

export async function readWorkspaceImage(fileSystem: IFileSystem, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return ok({
      success: false as const,
      error: `Unsupported image format: ${ext}. Allowed: ${Array.from(ALLOWED_IMAGE_EXTENSIONS).join(', ')}`,
    });
  }

  const result = await fileSystem.readBytes(filePath, { maxBytes: MAX_IMAGE_SIZE });
  if (!result.success) {
    return ok({ success: false as const, error: fileErrorToMessage(result.error) });
  }
  if (result.data.truncated) {
    return ok({
      success: false as const,
      error: `Image too large: ${result.data.totalSize} bytes (max ${MAX_IMAGE_SIZE})`,
    });
  }

  const mimeType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
  const base64 = Buffer.from(result.data.bytes).toString('base64');
  return ok({
    success: true as const,
    dataUrl: `data:${mimeType};base64,${base64}`,
    mimeType,
    size: result.data.totalSize,
  });
}
