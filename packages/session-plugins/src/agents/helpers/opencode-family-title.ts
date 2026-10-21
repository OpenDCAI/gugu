/**
 * opencode 家(opencode / mimocode)的会话名。它们在首条消息之后由 title agent 拟一次(opencode
 * `session/prompt.ts` 的 `ensureTitle`,mimocode 0.1.15 的 `genTitle`),这不是咕咕多花的调用。
 * - ACP 腿不转发 `session.updated`,名字只在 `session/list` 里给(`IAcpBehavior.sessionTitleFromList`);
 * - TUI 腿是 serve/attach,名字随 serve 的 `/event` SSE 里的 `session.updated` 到(`opencodeFamilyUpdatedTitle`)。
 *
 * 拟名之前是占位 `New session - <ISO>`(子会话 `Child session - …`,opencode `session.ts`),那不是名字。
 */
export function opencodeFamilyListedTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed || PLACEHOLDER_TITLE.test(trimmed)) return null;
  return trimmed;
}

/**
 * `session.updated` 的 `info` → 这条会话的名。mimocode 0.1.15 起在拟名之前先写一句它自己的首句兜底
 * (`titleSource: fallback`),咕咕也有这一档,不收。子会话(有 `parentID`)不是这一行。
 */
export function opencodeFamilyUpdatedTitle(info: unknown): string | null {
  if (!info || typeof info !== 'object') return null;
  const record = info as { title?: unknown; parentID?: unknown; titleSource?: unknown };
  if (record.parentID || record.titleSource === 'fallback') return null;
  return typeof record.title === 'string' ? opencodeFamilyListedTitle(record.title) : null;
}

const PLACEHOLDER_TITLE = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;
