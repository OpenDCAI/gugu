/**
 * 正文里那条指着一件附件的 mention，在消息里应该**显示成那件附件**（#5269）。
 *
 * owner 2026-09-10 连发两张图指出了这条边界：第二张（在任务里发的）走 ACP 附件上传，落进
 * `ChatMessage.attachments`，消息卡的缩略图条把它画了出来；**首轮那张**（新建会话页发的）
 * 那时还没有活的 agent 会话，唯一的送达方式是把绝对路径拼进正文（见
 * `use-create-session-callback` 的 `pathAttachmentMentions`）—— 于是它只是一段文本里的一枚 pill。
 * **同一件东西，因为传输方式不同长成了两个样子。** 用户看的是「我发了一张图」，
 * 传输方式不该在这里显形。
 *
 * 所以这里把那种 mention 从正文里摘出来，投影成 `attachments` —— 复用已有的附件条，
 * ❌ 不新造一种行。副作用是正文里那枚 pill 消失了，这是有意的：附件已经画在上面了，
 * 再留一条路径就是把传输方式摆回用户脸上。
 *
 * ⚠️ **图片和别的文件一样摘**（owner 2026-09-10：「这里的逻辑和创建任务时候保持一致才对」）。
 * 从前只摘图片，于是同一条消息里两件附件长成两个样子：图是缩略图，PDF 是正文里一枚裸的
 * 文字 pill，挤在文末。现在两种都进附件条，非图片画成一枚文件 chip。
 *
 * ⚠️ 判据是**目标是不是一条绝对路径**，不是扩展名。相对路径（agent 惯写的
 * `@[src/a/b.ts](src/a/b.ts)`、用户 @ 出来的工作区文件）是**正文里的引用**，不是这条消息
 * 的附件 —— 摘走它们会把一句话里提到的文件变成「我附了它」。
 */
import type { ChatAttachment } from '../../model';

/** 这些画成缩略图,其余画成一枚文件 chip。 */
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|svg)$/i;

/**
 * 附件的 mention 目标恒是绝对路径 —— composer 把文件落盘后写的就是绝对路径
 * (见 `stringifyMention` 的调用点)。相对路径一律是正文里的引用,留着当 pill。
 */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;

/**
 * `@[label](target)` —— 与 `stringifyMention` 写出来的形状一一对应(见
 * `@gugu/session-shared/markdown/mention-grammar`):目标含空格时它会包一层尖括号。
 */
const MENTION = /@\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/g;

/** 这枚 attachment 的字节要去哪儿取:`path:` 前缀 = 宿主按这条绝对路径读盘。 */
export const PATH_ATTACHMENT_PREFIX = 'path:';

/** 摘走一件附件之后留下的空位。收拾空白时只看它左右,收完就删掉。 */
const HOLE = '\u0000';

export function pathAttachmentTarget(id: string): string | null {
  return id.startsWith(PATH_ATTACHMENT_PREFIX) ? id.slice(PATH_ATTACHMENT_PREFIX.length) : null;
}

export interface SplitAttachmentMentions {
  /** 摘掉附件 mention 之后的正文。 */
  text: string;
  /** 摘出来的那几件,按出现顺序。 */
  attachments: ChatAttachment[];
}

export function splitAttachmentMentions(text: string): SplitAttachmentMentions {
  if (!text.includes('@[')) return { text, attachments: [] };
  const attachments: ChatAttachment[] = [];
  // 摘掉的位置先打一个哨兵,收拾空白时只动它左右两边 —— ❌ 不要全局压空格,
  // 那会顺手压掉缩进代码块和表格对齐。
  const stripped = text.replace(MENTION, (whole, label: string, rawTarget: string) => {
    const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
    if (!ABSOLUTE_PATH.test(target)) return whole;
    attachments.push({
      id: `${PATH_ATTACHMENT_PREFIX}${target}`,
      // 用户读的名字是作者显式写的 label —— ❌ 不从路径反推(盘上那个文件名带着防重名的 id)。
      name: label,
      kind: IMAGE_PATH.test(target) ? 'image' : 'file',
    });
    return HOLE;
  });
  if (attachments.length === 0) return { text, attachments: [] };
  // 摘完之后收拾空白:句中留下的那个空位两边各有一个空格,收成一个;行首/行尾的直接抹掉。
  // 再把一行里只剩空格的行去掉、行尾空格去掉、连续空行压成一个。
  // ❌ 不整段 trim 掉换行结构 —— 用户在附件前后写的段落关系要保住。
  const cleaned = stripped
    .replace(/[^\S\n]*\u0000[^\S\n]*/g, (whole, offset: number, whole2: string) => {
      const before = whole2[offset - 1];
      const after = whole2[offset + whole.length];
      const insideLine = before !== undefined && before !== '\n' && after !== undefined && after !== '\n';
      return insideLine ? ' ' : '';
    })
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return { text: cleaned, attachments };
}
