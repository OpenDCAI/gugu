import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { jwtPayload, objectAt } from '../../helpers/subscription';
import { readCodexCredentials } from './credentials';

export type CodexCredentialKind = 'subscription' | 'api-key' | 'unknown';

/**
 * Codex persists the selected auth mode in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
 *
 * The official Codex AuthMode enum serializes `ApiKey` as `apikey` and `Chatgpt`
 * as `chatgpt`; see openai/codex `codex-rs/app-server-protocol/src/protocol/common.rs`.
 * `ctx.fs` is anchored at the home (Codex is `injectionMode: 'runtime'`, no managed config root), so the
 * path is home-relative — #7146: it used to read `auth.json` at the home itself and answered `unknown`
 * on every machine. If the user moved CODEX_HOME but this fs is still anchored at the real home,
 * reading auth.json would answer for the wrong account, so return unknown.
 */
export async function codexCredentialKind(ctx: AgentAuthContext): Promise<CodexCredentialKind> {
  return (await codexCredentialInfo(ctx)).kind;
}

export async function codexCredentialInfo(ctx: AgentAuthContext): Promise<{ kind: CodexCredentialKind; account?: string }> {
  if (ctx.env.CODEX_HOME && !ctx.fsFollowsConfigRoot) return { kind: 'unknown' };
  try {
    const parsed: unknown = await readCodexCredentials(ctx);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unknown' };
    const mode = (parsed as { auth_mode?: unknown }).auth_mode;
    if (mode === 'apikey') return { kind: 'api-key' };
    if (mode === 'chatgpt') {
      const email = jwtPayload(objectAt(parsed, 'tokens')?.id_token)?.email;
      return { kind: 'subscription', ...(typeof email === 'string' && email ? { account: email } : {}) };
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
