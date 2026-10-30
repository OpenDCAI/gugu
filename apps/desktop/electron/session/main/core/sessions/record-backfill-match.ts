import type { TranscriptTurn } from '@gugu/session-core/acp';

/**
 * 认「库里这一轮 = 记录里那一轮」靠什么,按记录的格式分:
 * - `ids`:Claude 的记录里存的就是 Claude 自己发的编号(消息 id、工具调用 id),与运行时落库的同一套。
 * - `content`:Codex 的记录读取器按行号给条目编号,运行时落库的是 app-server 的条目 id、工具调用也是另一套
 *   (`exec-…` 对 `call_…`)⇒ 编号永远对不上,只能按内容认:人说的那句 + agent 最后回的那句。
 * - Hermes 的记录用 SQLite 行号(`hermes:<id>#0`),实时文本没消息编号,旧回放又用 `hermes-row-<id>` ⇒ 同样按内容认。
 *
 * 只有这三家接回时不重放、历史以记录为准;其余几家照旧重放,这里给 `null`(不补)。
 */
export type RecordIdentity = 'ids' | 'content';

export function recordIdentityFor(harness: string | null | undefined): RecordIdentity | null {
  if (harness === 'claude') return 'ids';
  if (harness === 'codex' || harness === 'hermes') return 'content';
  return null;
}

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

const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

/** 这一轮人说的那句,压掉空白、取前 300 字。没有提问(agent 自己开的头)= null。 */
export function turnPrompt(turn: TranscriptTurn): string | null {
  const user = turn.items.find((item) => item.kind === 'message' && item.role === 'user');
  const text = user && 'text' in user ? squeeze(user.text) : '';
  return text || null;
}

/** 问答成对的指纹:人说的那句 + agent 最后回的那句。只有一边(只调了工具、没说话)= null。 */
export function turnFingerprint(turn: TranscriptTurn): string | null {
  const prompt = turnPrompt(turn);
  const replies = turn.items.filter((item) => item.kind === 'message' && item.role === 'assistant' && 'text' in item && item.text.trim());
  const reply = replies.at(-1);
  if (!prompt || !reply || !('text' in reply)) return null;
  return `${prompt}\u0000${squeeze(reply.text)}`;
}

type Identity = { keys: Set<string>; fingerprint: string | null; prompt: string | null };

const identify = (turn: TranscriptTurn): Identity =>
  ({ keys: turnIdentityKeys(turn), fingerprint: turnFingerprint(turn), prompt: turnPrompt(turn) });

/** 拿来定位的认法:只认确定的身份 —— 编号,或问答成对的指纹。光凭提问原文不定位:「继续」会重复。 */
function anchors(a: Identity, b: Identity, mode: RecordIdentity): boolean {
  if (mode === 'ids') return [...a.keys].some((key) => b.keys.has(key));
  return a.fingerprint !== null && a.fingerprint === b.fingerprint;
}

/** 排除用的认法,宽一档:锚点之后、库里已有的那几轮(失败的、只说了话的)可能连编号都没有,只剩提问原文。 */
function sameTurn(a: Identity, b: Identity, mode: RecordIdentity): boolean {
  if (anchors(a, b, mode)) return true;
  if (mode === 'ids' && a.keys.size > 0 && b.keys.size > 0) return false;
  return a.prompt !== null && a.prompt === b.prompt;
}

/**
 * 记录里接在库尾之后、库里还没有的那几轮,由旧到新。`storedNewestFirst` 是库尾那几行,由新到旧。
 *
 * 从库尾最新的一行起往旧找,第一行在记录里认得出的就是锚点(取它在记录里最后出现的位置);记录里锚点之后的都要补,
 * 只除掉库里比锚点还新、记录里却没认出来的那几行(失败的、没进记录的)—— 每行只抵一次,重复的「继续」不会被一并吞掉。
 *
 * - 库是空的 ⇒ 整份记录都要补。
 * - 库尾一行都认不出 ⇒ `null`:记录与库已经岔开(换了记录、被改写过),❌ 把整份记录接在后面。
 * - 按编号认、库尾却一个编号都没有(全是只说话的轮)⇒ 这一次按问答指纹认。
 */
export function recordTurnsAfterStore(
  record: readonly TranscriptTurn[],
  storedNewestFirst: readonly TranscriptTurn[],
  identity: RecordIdentity = 'ids',
): TranscriptTurn[] | null {
  if (storedNewestFirst.length === 0) return [...record];
  const stored = storedNewestFirst.map(identify);
  const mode: RecordIdentity = identity === 'ids' && stored.every((one) => one.keys.size === 0) ? 'content' : identity;
  const seen = record.map(identify);
  for (let newer = 0; newer < stored.length; newer += 1) {
    let at = -1;
    for (let index = seen.length - 1; index >= 0; index -= 1) {
      if (anchors(seen[index], stored[newer], mode)) {
        at = index;
        break;
      }
    }
    if (at < 0) continue;
    const unrecognized = stored.slice(0, newer);
    return record.slice(at + 1).filter((_, offset) => {
      const hit = unrecognized.findIndex((one) => sameTurn(seen[at + 1 + offset], one, mode));
      if (hit < 0) return true;
      unrecognized.splice(hit, 1);
      return false;
    });
  }
  return null;
}
