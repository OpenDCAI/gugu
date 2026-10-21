/**
 * MiMo Code 把失败的回合报成「正常结束」—— 认出它。
 *
 * `mimo acp`(Homebrew 0.1.14,opencode 一家)没有凭据时:`session/prompt` 约 13 秒后回 `end_turn`、0 token,
 * 一个字的回复、一条错误都不发;stdout 与 stderr 都是空的(10-07 mac1 裸 ACP 实测)。同一个进程加它自己的
 * `--print-logs`,stderr 上就有这一轮的真因,由处理这一轮的那一层写出:
 *
 *   ERROR 2026-10-07T12:06:43 +1ms service=session.processor session.id=ses_… messageID=msg_…
 *     error=Invalid API Key stack=AI_APICallError: Invalid API Key
 *
 * 只认 `service=session.processor` 那一行:同一轮里 `service=llm` 也会报 ERROR(拟标题那一路也失败),
 * 那些行带整份请求体,而且拟标题失败不等于这一轮失败。
 * 凭据类的(AI_APICallError 的 401 / Invalid API Key)带 `signInRequired`:界面据此给「去登录」。
 */
const PROCESSOR_ERROR = /\bservice=session\.processor\b.*?\berror=(.+?)(?:\s+stack=.*)?$/;
const CREDENTIAL_FAILURE = /invalid api key|unauthorized|\b401\b/i;

export function mimocodeFailureFromStderrLine(
  line: string
): string | { message: string; signInRequired: true } | null {
  if (!line.startsWith('ERROR')) return null;
  const match = PROCESSOR_ERROR.exec(line.trim());
  if (!match) return null;
  const message = match[1]!.trim();
  return CREDENTIAL_FAILURE.test(message) ? { message, signInRequired: true } : message;
}
