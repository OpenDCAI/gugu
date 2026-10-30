/**
 * 一件拖/粘进输入框的附件,**发给 agent 的 mention 该指向哪儿**(#5269)。
 *
 * ⚠️ 2026-09-10 起它不再决定「要不要拷贝」—— 字节一律存一份(owner 拍板:只记指向的话,
 * 那件东西同时依赖「原文件还在不在」和「它在不在 home 里」,而 home 之外点开直接判死)。
 * 这里剩下的唯一问题是:用户自己盘上那个文件,**能不能拿去给 agent 当目标**。
 *
 * 这个取舍只有渲染层判得了:同一个 `File`,拖进来的带着用户自己盘上的真路径,
 * 粘贴进来的没有路径(Chromium 给的是空串,或者一个马上就会消失的拖放临时路径)。
 * 主进程拿到的只是参数,看不出来源 —— ❌ 别把这个判断挪下去让它猜。
 *
 * - `reference` —— 有一条稳定的原路径:mention 指它。那是用户的东西,他可能正想让 agent
 *   就地改它,指向副本就改错了对象。
 * - `copy` —— 没有可给的原路径(粘贴、剪贴板、长文本收成的 .txt),mention 只能指副本。
 *   原路径在别的 App 的私有目录或临时目录里(`mustCopyRatherThanReference`,#985)也归这一支:
 *   前者让 agent 之后的读弹系统授权框,后者随时会没。
 *   HEIC/HEIF 也归这一支:它要先转成 PNG 才有 agent 读得懂,而原路径指着的还是 `.heic`。
 */
export function composerAttachmentSource(args: {
  originalPath: string;
  mustCopy: boolean;
  isHeicLike: boolean;
}): 'reference' | 'copy' {
  if (!args.originalPath) return 'copy';
  if (args.mustCopy) return 'copy';
  if (args.isHeicLike) return 'copy';
  return 'reference';
}
