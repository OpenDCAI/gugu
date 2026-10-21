import { getFileKind } from '@renderer/lib/editor/fileKind';

/**
 * 点开一件附件,该开在哪儿(#5269)。
 *
 * owner 2026-09-10:「文件我点击可以是 tab 打开吧」—— 默认答案是**会话页里的一个 tab**,
 * 交给系统默认程序是最后一招(那会把人踢出咕咕,还得自己切回来)。
 *
 * ⚠️ 判据**直接问文件 tab 自己那张表**(`getFileKind` → `FILE_CONTENT_TYPES`),
 * ❌ 不在这里另抄一份扩展名清单。抄一份的下场是:那张表里加了 PDF,这里还当它是二进制,
 * 于是一件明明画得出来的东西被推给了系统 —— 同一个问题两个答案,迟早对不上。
 */
export type AttachmentOpenTarget = 'editor' | 'system';

export function attachmentOpenTarget(path: string): AttachmentOpenTarget {
  return getFileKind(path) === 'binary' ? 'system' : 'editor';
}
