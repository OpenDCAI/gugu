import type { SerializedError } from '@gugu/session-shared';

/**
 * ACP 协议规定的「要先登录」错误码(`RequestError.authRequired` → -32000)。
 * 出处:https://agentclientprotocol.com —— `authenticate` 一节与 RFD `logout-method`
 * (「Subsequent authentication-requiring requests should return `auth_required` error」);
 * SDK 里是 `static authRequired(data, msg) { return new RequestError(-32000, 'Authentication required…', data) }`。
 * claude-agent-acp 在一轮因登录失败时正是用它拒掉 `session/prompt`(`acp-agent.js` 的 `AUTH_REQUIRED_CODE`)。
 */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * codex app-server 的 `TurnError.codexErrorInfo` 里表示「凭据不被接受」的那一格。
 *
 * 咕咕自己的 codex 桥(`codex-app-server-acp.mjs` 的 `settleAcpIds`)把失败回合的 `turn.error`
 * 原样放进 JSON-RPC 错误的 `data`,于是这一格一路到得了这里。判据与 OpenAI 官方的 codex-acp 同一条
 * (`isAuthenticationRequiredError`: `error === "unauthorized" || httpStatusCode === 401`)。
 * 真机读数(d22,2026-09-24,refresh token 已失效):
 * `{ code: -32603, data: { message: "Your access token could not be refreshed…", codexErrorInfo: "unauthorized" } }`。
 */
const CODEX_UNAUTHORIZED = 'unauthorized';

/**
 * claude-agent-acp 在一轮因 API 报错结束时,用 `-32603` 拒掉 `session/prompt`,并把 Claude Agent SDK 自己的错误类别
 * 原样放进 `data.errorKind`(与终端腿 StopFailure 的 `error` 同一个词表,见 claude/hooks.ts)。这两类是「这份登录不能用了」,
 * 桥自己也把它们归成 `auth_required`;`verification_required` / `cloud_credential_error` 桥明说 `/login` 修不好,不认。
 * 真机读数(mac1,2026-09-30,F83):`{ code: -32603, message: "Internal error: Failed to authenticate. API Error: 403 Request not allowed",
 * data: { errorKind: "authentication_failed" } }`。
 */
const CLAUDE_SIGN_IN_ERROR_KINDS: ReadonlySet<string> = new Set(['authentication_failed', 'oauth_org_not_allowed']);

/**
 * codex 0.156 起,会话开口前先做一次「工作区路由发现」(`wham/accounts/check`,app-server README
 * 「Selected workspace routing」)。那一步被 401 拒时,codex **自己没有**给结构化分类 ——
 * 实测(gugu-walk,codex 0.156.1,本地假端点回 401):
 * `{ code: -32603, data: { message: "workspace routing discovery unauthorized (401)", codexErrorInfo: "other" } }`。
 * 没有结构化信号可用时,只认 codex 这句话里它自己写出的 HTTP 状态「unauthorized (401)」,
 * ❌ 不认「log out」「sign in again」这类会漂的说法。
 */
const CODEX_UNCLASSIFIED_401 = /\bunauthorized \(401\)/i;

/**
 * 这次被拒是不是「这家在这台机器上的登录不能用了」(#6264)—— 认结构化信号,❌ 不按句子猜。
 * 唯一的例外是 codex 自己没分类的那一步(见 `CODEX_UNCLASSIFIED_401`),也只认它写出的状态码。
 *
 * 句子会漂(同一件事 codex 有「could not be refreshed」「was revoked」「was already used」三种说法,
 * claude 有「Not logged in」「Session expired」),而协议码与错误分类是对方明确给出的契约。
 */
export function isSignInFailure(cause: SerializedError): boolean {
  if (cause.code === ACP_AUTH_REQUIRED_CODE) return true;
  const data = cause.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (typeof record.errorKind === 'string' && CLAUDE_SIGN_IN_ERROR_KINDS.has(record.errorKind)) return true;
  if (record.codexErrorInfo === CODEX_UNAUTHORIZED) return true;
  if (record.codexErrorInfo === 'other' && typeof record.message === 'string' && CODEX_UNCLASSIFIED_401.test(record.message)) {
    return true;
  }
  // 序列化只留一层原始值(`toSerializedError`),嵌套的 `{ httpConnectionFailed: { httpStatusCode: 401 } }`
  // 到不了这里;平铺出来的状态码照认。
  return record.httpStatusCode === 401;
}
