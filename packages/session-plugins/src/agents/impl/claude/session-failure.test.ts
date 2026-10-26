import type { PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { claudePromptFailure, enrichClaudeUpdate } from './acp-transform';

const meta = (severity: string, title: string, details?: string) => ({
  jetbrains: { air: { version: 1, sessionFailure: { id: 'failure-1', revision: 1, severity, title, details, category: 'service', actions: [] } } },
});

describe('Claude native sessionFailure', () => {
  it('uses the same provider notice as Codex for retry metadata, without making a warning terminal', () => {
    const raw: SessionUpdate = { sessionUpdate: 'session_info_update', _meta: meta('warning', 'Retrying Claude, attempt 1 of 10.') };
    expect(enrichClaudeUpdate(decodeSessionUpdate(raw), raw)).toEqual({
      kind: 'session_notice', code: 'provider-notice', title: 'Retrying Claude, attempt 1 of 10.', detail: 'Retrying Claude, attempt 1 of 10.',
    });
    expect(claudePromptFailure({ stopReason: 'end_turn', _meta: raw._meta })).toBeNull();
  });

  it('takes the terminal cause from the new prompt/idle metadata and sanitizes it', () => {
    const response: PromptResponse = { stopReason: 'end_turn', _meta: meta('error', 'API Error: 529 fixture overloaded', 'bad key sk-fixture-secret-abcdefghijklmnopqrstuvwxyz') };
    expect(claudePromptFailure(response)).toBe('API Error: 529 fixture overloaded\nbad key [REDACTED_OPENAI_KEY]');
    expect(claudePromptFailure({ stopReason: 'end_turn' })).toBeNull();
  });
});
