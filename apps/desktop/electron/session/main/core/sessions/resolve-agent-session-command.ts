import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { Session } from '@shared/core/sessions/sessions';

export const FORK_SESSION_ID_MISSING_MESSAGE =
  'fork session exited without reporting a new resumable session id';

/**
 * Resolves the session id and resume flag to pass to the agent CLI.
 *
 * 两类会话,两种答案:
 *
 * - **咕咕铸的 id**(绝大多数):起 pty 会话时咕咕拿 `--session-id <conversation.id>` 把 id 交给引擎,
 *   所以续跑当然还用 `conversation.id`。claude 的分叉也走这条 —— 子会话的 id 是分叉那一刻咕咕给的,
 *   哪怕 `session_id` 这一格里此刻放着别的东西(见同名单测)。
 * - **引擎铸的 id**:会话记录上带 `providerMintedSessionId` 时,`session_id` 里那个 id 是引擎自己
 *   铸的(今天唯一的来源是 spec session-runtime-switch:一条通用模式会话换到编程模式,它的 id 由
 *   ACP 适配器铸)。这时必须用它续 —— 用 `conversation.id` 会指向一条**根本不存在**的会话,
 *   claude 于是起一条全新的空会话,而界面上一个字都不会说(2026-09-09 本机实测)。
 * - 声明了 `sessions.resumeNeedsProviderId` 的家(Droid / Codex …)缺 id 时**不许假装在续**:`--last` 之类会按 cwd
 *   猜一条,猜中与猜不中都不是用户点的那条。
 */
export function resolveAgentSessionCommandArgs(
  session: Session,
  isResuming: boolean,
  options: { requireProviderSessionId?: boolean } = {}
): { cliSessionId: string; isResuming: boolean } {
  const nativeSessionId = session.providerSessionId;
  const hasNativeId = !!nativeSessionId && nativeSessionId !== session.id;
  if (isResuming && hasNativeId && session.providerMintedSessionId) {
    return { cliSessionId: nativeSessionId!, isResuming: true };
  }
  if (pluginRegistry.get(session.providerId)?.capabilities.sessions.resumeNeedsProviderId && isResuming) {
    if (hasNativeId) {
      return { cliSessionId: nativeSessionId!, isResuming: true };
    }
    if (options.requireProviderSessionId === false) {
      return { cliSessionId: session.id, isResuming };
    }
    return { cliSessionId: session.id, isResuming: false };
  }

  return { cliSessionId: session.id, isResuming };
}

export function resolveForkResumeCommandArgs(
  session: Session,
  sourceProviderSessionId?: string,
): { cliSessionId: string; isResuming: true } {
  const resolved = resolveAgentSessionCommandArgs(session, true);
  if (
    !resolved.isResuming ||
    (sourceProviderSessionId !== undefined && session.providerSessionId === sourceProviderSessionId)
  ) {
    throw new Error(FORK_SESSION_ID_MISSING_MESSAGE);
  }
  return { cliSessionId: resolved.cliSessionId, isResuming: true };
}
