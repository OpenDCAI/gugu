/**
 * 输入框里那几枚**非图片**附件 chip,怎么变成 agent 真的拿得到的东西(#5269)。
 *
 * ACP 的附件上传只收图片,所以非图片文件到达 agent 的唯一途径是**正文里的绝对路径**。
 * 但路径是传输方式,不该摆到用户脸上 —— 屏幕上是 chip,路径只在按下发送的那一刻拼进正文。
 * 这一步是整条链上最容易静默出错的一格:漏掉它,chip 照样显示、消息照样发出去,而文件
 * 从没到过 agent。所以它是纯函数。
 */
import { stringifyMention } from '@gugu/session-shared/markdown';

/**
 * 把 chip 序列化成 `@[名字](绝对路径)`。
 *
 * ⚠️ 没有记录到路径的 chip **不产出 mention** —— 图片走的是 ACP 附件上传,本来就不在这条路上。
 * ❌ 别在这里给它编一个路径:那会让一条指向不存在文件的 mention 混进正文。
 */
export function fileMentionsFor(
  attachments: readonly { id: string; name: string }[],
  paths: ReadonlyMap<string, string>
): string[] {
  return attachments.flatMap((attachment) => {
    const path = paths.get(attachment.id);
    return path ? [stringifyMention({ label: attachment.name, target: path, kind: 'file' })] : [];
  });
}

/** 正文 + 路径 mention。两边都空就是空字符串 —— 调用方据此判断「这一轮有没有内容」。 */
export function composePromptText(value: string, mentions: readonly string[]): string {
  return [value.trim(), ...mentions].filter((part) => part.length > 0).join('\n');
}
