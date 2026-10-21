import { describe, expect, it } from 'vitest';
import { antigravityFailureFromAgentMessage, antigravityFailureFromStderrLine } from './turn-failure';

describe('Antigravity turn failures reported as end_turn (#6335)', () => {
  it('认出服务改写成回复的那几类错误,原话整段交出', () => {
    const cases = [
      'Agent execution error: Agent execution terminated due to error. ("request failed (code 400): quota")',
      'Usage Limit Reached\n\nYou have reached your current quota for this period.',
      "The MCP server 'broken' failed to initialize: EOF. Fix or remove it.",
      'Browser automation could not start (the chrome-devtools-mcp tool failed).',
      'Agent connection was lost and could not be re-established: closed',
    ];
    for (const text of cases) expect(antigravityFailureFromAgentMessage(text)).toBe(text);
  });

  it('普通回复不算失败', () => {
    expect(antigravityFailureFromAgentMessage('The agent execution error you saw earlier was a typo.')).toBeNull();
    expect(antigravityFailureFromAgentMessage('ok')).toBeNull();
  });

  it('stderr 里执行器那行 Agent run failed', () => {
    expect(antigravityFailureFromStderrLine(
      'I0924 05:29:11.457799 6166786048 local_connection.py:578] harness stderr: Agent run failed: failed to send input to trajectory: cascade ID mismatch'
    )).toBe('Agent run failed: failed to send input to trajectory: cascade ID mismatch');
    expect(antigravityFailureFromStderrLine('I0924 local_connection.py:578] harness stderr: request failed (code 400): x')).toBeNull();
  });
});
