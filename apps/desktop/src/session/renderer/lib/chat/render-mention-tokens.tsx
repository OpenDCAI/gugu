import type { ReactNode } from 'react';
import { AT_BARE_PATTERN } from '@gugu/session-shared/markdown';
import { chatMentionProvider } from './chat-mention-provider';

/**
 * 把一段**要发出去的原文**显示成人话:`@user:<uuid>` 换成 `@Codex 1`。
 *
 * 为什么需要它:@ 提及在原文里就是它的地址,那是发给 agent 的东西(`session_message` 三种正式
 * 地址之一)。输入框里它是一枚 pill、聊天记录里也是一枚 pill,只有「排队提示」那一条直接打印原文,
 * 于是 36 位 uuid 摆到了用户脸上(owner 2026-09-16 实撞)。
 *
 * 只换**认得出的**那些:名册里查不到的 token 原样留着,❌ 不许把一段不认识的字猜成某个人。
 */
/**
 * 两种写法都收:
 *  · `@[Claude 1](aid:<Agent ID>)` —— 现在写出去的形状,名字就摆在方括号里,直接取;
 *  · `@user:<id>` —— 2026-09-16 改名之前的裸写法,排队里可能还压着,按名册查回名字。
 */
const MENTION_PATTERN = new RegExp(
  String.raw`@\[([^\]]*)\]\(<?((?:aid|user):[^\s)>]+)>?\)|` + AT_BARE_PATTERN,
  'g'
);

export function renderMentionTokens(text: string, uri?: string): ReactNode {
  const pattern = new RegExp(MENTION_PATTERN.source, 'g');
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    const bracketName = match[1]?.trim();
    const bareToken = match[3];
    const name = bracketName
      ? bracketName
      : bareToken
        ? chatMentionProvider.resolve(bareToken, uri)?.name?.trim() ?? ''
        : '';
    if (!name) continue;
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    out.push(<span key={`m${key++}`}>@{name}</span>);
    cursor = match.index + match[0].length;
  }
  if (out.length === 0) return text;
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
