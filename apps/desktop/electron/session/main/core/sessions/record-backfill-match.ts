import type { TranscriptTurn } from '@gugu/session-core/acp';

/**
 * 一轮里 agent 自己发的编号:provider 的消息 id、工具调用 id。条目 id 是 `${回合 id}:message:${消息 id}`,
 * 回合 id 在库里重编号过、在记录里另有一套,只认 `:turn:<序号>:` 之后那一截。归约器合成的(`auto:`)不是身份。
 */
export function turnIdentityKeys(turn: TranscriptTurn): Set<string> {
  const keys = new Set<string>();
  const visit = (item: { kind?: string; id?: string; toolCallId?: string; children?: unknown[] }) => {
    if (item.toolCallId) keys.add(`tool:${item.toolCallId}`);
    if ((item.kind === 'message' || item.kind === 'thinking') && item.id) {
      const own = /:turn:[^:]+:(?:message|thinking):(.+)$/.exec(item.id)?.[1];
      if (own && !own.startsWith('auto:')) keys.add(`message:${own}`);
    }
    for (const child of item.children ?? []) visit(child as typeof item);
  };
  for (const item of turn.items) visit(item as Parameters<typeof visit>[0]);
  return keys;
}

/** 这一轮人说的那句,压掉空白、取前 300 字。没有提问(agent 自己开的头)= null。 */
export function turnPrompt(turn: TranscriptTurn): string | null {
  const user = turn.items.find((item) => item.kind === 'message' && item.role === 'user');
  const text = user && 'text' in user ? user.text.replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 300) : null;
}

/**
 * 记录里接在库尾之后、库里还没有的那几轮,由旧到新。`storedNewestFirst` 是库尾那几行,由新到旧。
 *
 * 从记录末尾往前找第一轮与库尾对得上的(按 agent 自己的编号),它后面的、又不与库尾任一行对上的,就是要补的。
 * 对号**只拿编号定位**:提问原文会重复(「继续」),拿它定位可能落到很早的一轮,把后面已有的整段再抄一遍。
 * 提问原文只用来排除 —— 没调工具、只说了话的那种轮没有编号。
 *
 * - 库是空的 ⇒ 整份记录都要补。
 * - 库尾有编号却一轮都对不上 ⇒ `null`:记录与库已经岔开(换了记录、被改写过),❌ 把整份记录接在后面。
 * - 库尾一个编号都没有(全是只说话的轮)⇒ 退回按提问原文定位。
 */
export function recordTurnsAfterStore(
  record: readonly TranscriptTurn[],
  storedNewestFirst: readonly TranscriptTurn[],
): TranscriptTurn[] | null {
  if (storedNewestFirst.length === 0) return [...record];
  const storedKeys = new Set<string>();
  const storedPrompts = new Set<string>();
  for (const turn of storedNewestFirst) {
    for (const key of turnIdentityKeys(turn)) storedKeys.add(key);
    const prompt = turnPrompt(turn);
    if (prompt) storedPrompts.add(prompt);
  }
  const byKey = (turn: TranscriptTurn) => [...turnIdentityKeys(turn)].some((key) => storedKeys.has(key));
  const byPrompt = (turn: TranscriptTurn) => {
    const prompt = turnPrompt(turn);
    return prompt !== null && storedPrompts.has(prompt);
  };
  const locate = storedKeys.size > 0 ? byKey : byPrompt;
  let last = -1;
  for (let index = record.length - 1; index >= 0; index -= 1) {
    if (locate(record[index])) {
      last = index;
      break;
    }
  }
  if (last < 0) return null;
  return record.slice(last + 1).filter((turn) => !byKey(turn) && !byPrompt(turn));
}
