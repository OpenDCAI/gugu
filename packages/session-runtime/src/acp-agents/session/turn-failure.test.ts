import { describe, expect, it } from 'vitest';
import type { SerializedError } from '@gugu/session-shared';
import { classifyTurnFailure } from './turn-failure';

it('shows the native structured 5xx cause on the failure line', () => {
  const message = 'We’re currently experiencing high demand, which may cause temporary errors.';
  const result = classifyTurnFailure({ at: 'prompt', cause: {
    name: 'RequestError', code: -32603, message, data: { message, codexErrorInfo: 'internalServerError' },
  } });
  expect(result.outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed', said: message });
});

// #7103 通用形态 Codex「回合失败」那一行要说网关回的那一句,❌ 只说「回合未能完成」让人点开猜。
// 夹具是真实读数:mac1 devdb,构建 8b9496a0,codex 0.156.1 通用形态,0 积分 → 网关只回话渠道回 400;
// 这一轮的错由 codex-app-server-acp 桥按 turn.error 原样转成 RequestError(code -32603,data = turn.error)。
const CODEX_CREDITS_EXHAUSTED: SerializedError = {
  name: 'RequestError',
  message: '{"error":{"message":"咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。","type":"invalid_request_error","param":"","code":"credits_exhausted"}}',
  data: {
    message: '{"error":{"message":"咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。","type":"invalid_request_error","param":"","code":"credits_exhausted"}}',
    codexErrorInfo: 'other',
  },
  code: -32603,
};

// 同一处、claude 通用形态的真实读数:claude 自己已经把「API Error: 400 …」作为它的话写进了转录,这一行 ❌ 再说一遍。
const CLAUDE_CREDITS_EXHAUSTED: SerializedError = {
  name: 'RequestError',
  message: 'Internal error: API Error: 400 咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。 (request id: 202610110149503685399668268d9d6eVM8PN5Y)',
  data: { errorKind: 'unknown' },
  code: -32603,
};

const prompt = (cause: SerializedError) => classifyTurnFailure({ at: 'prompt', cause, platformCredentials: true });

describe('#7103 回合失败那一行说上游回的那一句', () => {
  it('codex 原样递上来的网关错误体:那一行说网关那句,原文照旧在详情', () => {
    const { outcome } = prompt(CODEX_CREDITS_EXHAUSTED);
    expect(outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed', said: '咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。' });
    expect(outcome.kind === 'error' && outcome.detail).toContain('"code":"credits_exhausted"');
  });

  it('claude: the row says its words, without the JSON-RPC internal-error prefix', () => {
    const { outcome } = prompt(CLAUDE_CREDITS_EXHAUSTED);
    expect(outcome.kind === 'error' && outcome.said).toBe('API Error: 400 咕咕积分用完了。充值后再发一次，或等下个周期额度刷新。 (request id: 202610110149503685399668268d9d6eVM8PN5Y)');
  });

  // mac1 2026-11-05, claude 2.1.293 + gateway Haiku 5.5: four auto-compactions, then the turn ends on this.
  it('claude Prompt is too long: the row says it, not just "could not be completed"', () => {
    const { outcome } = prompt({ name: 'RequestError', code: -32603, message: 'Internal error: Prompt is too long', data: { errorKind: 'invalid_request' } });
    expect(outcome).toMatchObject({ kind: 'error', reason: 'prompt_failed', said: 'Prompt is too long', detail: expect.stringContaining('Prompt is too long') });
  });

  it('a dropped line said nothing: no sentence on the row', () => {
    const { outcome } = prompt({ name: 'Error', message: 'ACP connection closed' });
    expect(outcome.kind === 'error' && outcome.said).toBeUndefined();
  });

});
