/**
 * 掉进输入框的文件怎么变成一枚附件。
 *
 * 从 `index.tsx` 拆出来（#4981 A1，理由见 `composer-options.ts` 顶部）。
 * 这里只做「File → ComposerAttachment」这一件事，不碰 React —— 所以它能被直接单测，
 * 而它原来待的地方（一个 1390 行的组件文件）在本仓的组件测覆盖范围之外。
 */
import type { ComposerAttachment } from './composer-options';

const imageFileExtension = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;

/**
 * 粘贴的纯文本超过这么多字符就改当一个文件收(owner 2026-09-08 定的预期:「粘贴长文本也是转文件」)。
 *
 * 2000 字符 ≈ 一屏半正文:再多,输入框就从「你要说的话」变成了「一份被塞进来的材料」——
 * 编辑器要滚很久、发送前看不全、模型那边也只当成一段没有边界的正文。收成文件之后它有名字、
 * 有大小、能删,和拖进来的 .txt 是同一件东西。
 *
 * ⚠️ 这条只在宿主真的能收文件时生效(见 `onFilesDropped` 的判空)——收不了还拦下粘贴,
 * 用户的文字就凭空消失了,那比长一点糟得多。
 */
export const PASTED_TEXT_AS_FILE_MIN_CHARS = 2000;

/** 把一段粘贴来的长文本包成一个 `.txt` 文件,好让它走与拖进来的文件完全相同的那条路。 */
export function pastedTextFile(text: string): File {
  return new File([text], 'pasted-text.txt', { type: 'text/plain' });
}

/** chip 的 meta 行用:`1.2 MB` 这种人读大小。整字节不带小数(`"10.0 B"` 是编出来的精度)。 */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function isImageFile(file: File, declaredType = file.type): boolean {
  return declaredType.toLowerCase().startsWith('image/') || imageFileExtension.test(file.name);
}

/**
 * Read a dropped image file into a `ComposerAttachment` with a `data:` URL
 * preview. On read failure the attachment is still created (without
 * `previewUrl`) so the host shows a fallback tile rather than dropping it.
 */
export function readImageAttachment(file: File): Promise<ComposerAttachment> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        kind: 'image',
        previewUrl: typeof reader.result === 'string' ? reader.result : undefined,
        mimeType: file.type,
        meta: formatAttachmentSize(file.size),
      });
    reader.onerror = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        kind: 'image',
        mimeType: file.type,
        meta: formatAttachmentSize(file.size),
      });
    reader.readAsDataURL(file);
  });
}
