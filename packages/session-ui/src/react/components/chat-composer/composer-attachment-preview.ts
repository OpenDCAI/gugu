/**
 * 一枚 chip 点不点得开、点开看到什么 —— 这是唯一定义它的地方（#5269）。
 *
 * owner 2026-09-09 在新建会话页点着 chip 说「怎么没法展开预览啊,文件也是」。在那之前:
 * 图标格只在**图片**且宿主接了回调时才是个按钮,新建会话页压根没接 ⇒ 两种 chip 都是死的。
 *
 * 上游 assistant-ui 的 `elements-composer` chip 是个纯 div,没有任何点击行为;它的
 * runtime 车道(`attachment.aui.tsx`)才有预览,做法是**整块 tile 当 dialog trigger**,
 * 且 `useAttachmentSrc()` 取不到图就干脆不套 trigger —— 非图片在上游是点不开的。
 * ⇒ 「整块可点」照抄上游;「文件也能看」是 owner 定的增量:粘贴长文本收成的
 * `pasted-text.txt`(见 composer-attachment-file.ts)是我们自己造出来的东西,
 * 用户发出去之前没有第二条路能看见里面是什么。
 *
 * 判据落在**手上已经有的内容**上,而不是文件类型上:图片要有 `previewUrl`、文本要有
 * `previewText`。宿主入列时读不到就没有,chip 相应地退回不可点 —— ❌ 不要让 chip 点开
 * 一个空对话框,那比不可点更糟(用户以为坏了)。取不到内容的类型(.zip / .pdf 之类)
 * 同样落在这里:不可点,与上游一致。
 */
import type { ComposerAttachment } from './composer-options';

export type AttachmentPreviewKind = 'image' | 'text';

/** 这枚 chip 点开能看到什么;`null` = 手上没有可看的内容,chip 渲染成不可点。 */
export function attachmentPreviewKind(att: ComposerAttachment): AttachmentPreviewKind | null {
  if (att.kind === 'image' && att.previewUrl) return 'image';
  if (typeof att.previewText === 'string') return 'text';
  return null;
}

/** 预览最多读这么多字节。再大的就截断——预览是「看一眼里面是什么」,不是打开编辑器。 */
export const ATTACHMENT_PREVIEW_TEXT_MAX_BYTES = 512 * 1024;

const textFileExtension =
  /\.(?:txt|text|md|markdown|mdx|rst|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|csv|tsv|log|xml|svg|html?|css|scss|less|sql|sh|bash|zsh|fish|ps1|bat|py|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|pl|lua|r|jl|ex|exs|erl|hs|clj|scala|dart|vue|svelte|astro|[cm]?[jt]sx?|diff|patch|env|gitignore|dockerfile|makefile|lock)$/i;

/** `text/*` 之外，这些 application/* 也是给人读的文本。 */
const textualApplicationType =
  /^application\/(?:json|ld\+json|xml|xhtml\+xml|javascript|ecmascript|typescript|x-javascript|x-typescript|x-sh|x-shellscript|x-yaml|yaml|toml|sql|x-httpd-php|graphql)$/;

/**
 * 这个文件能不能当文本预览。
 *
 * 顺序是有意的:**声明的 MIME 优先,扩展名只在没声明时兜底**。反过来(先看扩展名)会把
 * 一个 `image/png` 的 `screenshot.log` 当文本读 —— 扩展名是用户能随手写错的那一半。
 */
export function isTextPreviewableFile(file: { type: string; name: string }): boolean {
  const type = file.type.trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (textualApplicationType.test(type)) return true;
  // 声明了别的**具体**类型就信它;只有「没声明」或「声明成一坨字节」时才靠扩展名猜。
  if (type && type !== 'application/octet-stream') return false;
  return textFileExtension.test(file.name);
}

export interface AttachmentPreviewText {
  text: string;
  /** 内容超过上限、只读了前一段。对话框据此挂一行说明,❌ 别让用户以为文件就这么长。 */
  truncated: boolean;
}

/**
 * 入列时把文本类附件的内容读进来,供 chip 点开时看。读不成(权限、编码、文件已消失)
 * 返回 `undefined` —— 那时 chip 退回不可点,而附件本身照常发得出去。
 */
export async function readAttachmentPreviewText(
  file: File
): Promise<AttachmentPreviewText | undefined> {
  if (!isTextPreviewableFile(file)) return undefined;
  const truncated = file.size > ATTACHMENT_PREVIEW_TEXT_MAX_BYTES;
  try {
    const slice = truncated ? file.slice(0, ATTACHMENT_PREVIEW_TEXT_MAX_BYTES) : file;
    return { text: await slice.text(), truncated };
  } catch {
    return undefined;
  }
}
