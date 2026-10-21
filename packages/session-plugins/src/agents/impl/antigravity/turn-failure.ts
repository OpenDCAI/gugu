/**
 * Antigravity 把失败的回合报成「正常结束」—— 认出它(#6335)。
 *
 * `agy_acp_server` 1.2.1 的 `prompt` 处理(server.py):SDK 抛的 `AntigravityExecutionError` /
 * `ConnectionError` / `ValidationError` 一律**改写成一条 `agent_message_chunk`**,然后照常回
 * `end_turn`。文字按类选一句(同一文件里的四个渲染器,原文见下),都是**整块一次发出**:
 *  · 通用:`Agent execution error: {e}`(假端点回 400 实测:「Agent execution error: Agent execution
 *    terminated due to error. ("request failed (code 400): …")」)
 *  · 额度:`quota_errors.py` 的 `Usage Limit Reached\n\nYou have reached your current quota …`
 *  · MCP:`mcp_errors.py` 的 `The MCP server '<name>' failed to initialize…`
 *  · 浏览器:`browser_subagent.py` 的 `Browser automation could not start …`
 *  · 断线:`_send_connection_lost_message` 的 `Agent connection was lost and could not be re-established: …`
 *
 * 更糟的一类连这句都没有:执行器在回合开头就失败(例:会话存档里的 id 与请求对不上),Python 那层只把
 * 执行器 stderr 记一行 `harness stderr: Agent run failed: …`,回合 `end_turn`、零输出(2026-09-24 实测)。
 */
const AGENT_MESSAGE_FAILURES = [
  /^Agent execution error: /,
  /^Usage Limit Reached\n/,
  /^The MCP server '[^']*' failed to initialize/,
  /^Browser automation could not start/,
  /^Agent connection was lost and could not be re-established/,
];

export function antigravityFailureFromAgentMessage(text: string): string | null {
  const trimmed = text.trim();
  return AGENT_MESSAGE_FAILURES.some((pattern) => pattern.test(trimmed)) ? trimmed : null;
}

const RUN_FAILED = /harness stderr: Agent run failed: (.+)$/;

export function antigravityFailureFromStderrLine(line: string): string | null {
  const match = RUN_FAILED.exec(line.trim());
  return match ? `Agent run failed: ${match[1]!.trim()}` : null;
}
