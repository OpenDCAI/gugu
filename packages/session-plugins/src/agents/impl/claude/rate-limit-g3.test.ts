/**
 * G3(主人 10-01 定):Claude 的桥把账号额度(SDK `rate_limit_event`)挂在一条 usage_update 的 `_claude/rateLimit` 上;
 * 这里把它收进中性的 `usage.rateLimit`(App 的 listAgents 从那里读),别的字段留在原处。
 * 对照组(父提交 9951620de):这一层不读这个键,usage 只有 contextUsed / contextSize / cost。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import { AcpTranscriptParser, type NormalizedEvent } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { createClaudeSessionDecoder } from './acp-transform';

const decodeClaudeSessionUpdate = createClaudeSessionDecoder();

const usage: NormalizedEvent = { kind: 'usage', usage: { contextUsed: 58_000, contextSize: 1_000_000, cost: null } };
const raw = (meta: Record<string, unknown> | undefined): SessionUpdate =>
  ({ sessionUpdate: 'usage_update', used: 58_000, size: 1_000_000, ...(meta ? { _meta: meta } : {}) }) as never;
const warning = { status: 'allowed_warning', resetsAt: 1_790_000_000, rateLimitType: 'five_hour', utilization: 0.91, isUsingOverage: false };

describe('the account limit the Claude bridge reports (G3)', () => {
  it('is taken into usage.rateLimit — resetsAt from Unix seconds to epoch ms; the rest of it stays behind', () => {
    expect(decodeClaudeSessionUpdate(raw({ '_claude/rateLimit': warning }))).toEqual({
      kind: 'usage',
      usage: {
        contextUsed: 58_000,
        contextSize: 1_000_000,
        cost: null,
        rateLimit: { status: 'allowed_warning', resetsAt: 1_790_000_000_000, window: 'five_hour', utilization: 0.91 },
      },
    });
  });

  it('with a guessed context window too: both apply (#6552)', () => {
    const out = decodeClaudeSessionUpdate(raw({ '_claude/rateLimit': { status: 'rejected' }, '_claude/contextWindowEstimated': true }));
    expect(out).toEqual({
      kind: 'usage',
      usage: { contextUsed: 58_000, contextSize: 0, cost: null, rateLimit: { status: 'rejected', resetsAt: null, window: null, utilization: null } },
    });
  });

  it('counter-cell: no limit, or one it cannot read, leaves the update as it was', () => {
    expect(decodeClaudeSessionUpdate(raw(undefined))).toEqual(usage);
    expect(decodeClaudeSessionUpdate(raw({ '_claude/rateLimit': { status: 'mystery' } }))).toEqual(usage);
  });

  it('the engine says it only when it changes: a later usage without one keeps the last; another replaces it', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'c' });
    parser.pushEvent(decodeClaudeSessionUpdate(raw({ '_claude/rateLimit': warning })));
    parser.pushEvent({ kind: 'usage', usage: { contextUsed: 61_000, contextSize: 1_000_000, cost: null } });
    expect(parser.usage).toMatchObject({ contextUsed: 61_000, rateLimit: { status: 'allowed_warning' } });
    parser.pushEvent(decodeClaudeSessionUpdate(raw({ '_claude/rateLimit': { ...warning, status: 'allowed' } })));
    expect(parser.usage?.rateLimit?.status).toBe('allowed');
    // Control: a session that never had one has none.
    const other = new AcpTranscriptParser({ sessionId: 'd' });
    other.pushEvent(usage);
    expect(other.usage).toEqual(usage.kind === 'usage' ? usage.usage : null);
  });
});
