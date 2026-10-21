import { log } from '@renderer/utils/logger';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';

type Translate = ReturnType<typeof useSessionMessages>['translate'];
type SessionMessageKey = Parameters<Translate>[0];

/**
 * 版本控制操作失败时，信息分成两半，走两条路（#4891，owner 2026-09-04 拍板取 B）：
 *
 * - **工具自己的话** —— `error.message`，也就是 `git` 的 stderr（「nothing to commit」
 *   「would be overwritten by merge」）。会话页的用户就是在直接操作版本控制，这句话他能照做，
 *   **收进日志等于把他要的答案拿走**，所以照常显示。
 * - **我们的内部标签** —— `error.type`（`git_error` / `not-repository` / `init-failed`），
 *   对用户零价值，只进日志。
 *
 * 改这里之前，界面上出现的是标签而不是那句话：中文界面弹出「提交失败：git_error」，
 * 而 stderr 被整个丢掉——既没给用户，也没进日志。两头都不对。
 *
 * 同文件夹的 `formatFetchErrorDetail` / `formatPushErrorDetail` 早就是这个形状
 * （已知形态映射成产品文案，未知的原样带出底层 message），本模块只是把 stage/unstage/
 * discard/commit/push/pull 这几条也拉齐。
 */
function vcsErrorType(error: unknown): string {
  return error && typeof error === 'object' && 'type' in error
    ? String((error as { type: unknown }).type)
    : String(error);
}

/** 工具自己的话；没有就返回 null（❌ 不拿 `type` 顶替——那正是要治的病）。 */
function vcsErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('message' in error)) return null;
  const message = String((error as { message: unknown }).message ?? '').trim();
  return message || null;
}

/**
 * 记一条日志（含内部标签），并返回**给用户看的那一句**。
 *
 * ❌ 不要拆成「只取文案」和「只打日志」两个函数分别调用：这两半必须成对，
 * 拆开就会有人只调其中一个，于是原因要么外泄要么消失。
 */
export function vcsFailureText(
  scope: string,
  error: unknown,
  translate: Translate,
  key: SessionMessageKey
): string {
  const detail = vcsErrorMessage(error);
  log.error(`[session/vcs] ${scope} failed`, { type: vcsErrorType(error), detail });
  return translate(key, { detail: detail ?? translate('git.reasonUnavailable') });
}
