import { describe, expect, it } from 'vitest';
import { opencodeFamilyListedTitle, opencodeFamilyUpdatedTitle } from './opencode-family-title';

describe('opencodeFamilyListedTitle (ACP session/list)', () => {
  it('keeps a generated title', () => {
    expect(opencodeFamilyListedTitle(' Fix login redirect ')).toBe('Fix login redirect');
  });

  it('the pre-title placeholder is not a name', () => {
    expect(opencodeFamilyListedTitle('New session - 2026-09-25T03:00:00.000Z')).toBeNull();
    expect(opencodeFamilyListedTitle('Child session - 2026-09-25T03:00:00.000Z')).toBeNull();
    expect(opencodeFamilyListedTitle('  ')).toBeNull();
  });
});

// serve 的 `/event` SSE 里 `session.updated` 的 `info`(opencode 1.18.25 实测:ses_… 会话拟名为「Quick check-in」)。
describe('opencodeFamilyUpdatedTitle (TUI serve/attach)', () => {
  it('a generated title is the name', () => {
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_1', title: 'Quick check-in' })).toBe('Quick check-in');
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_1', title: 'Fix login', titleSource: 'generated' })).toBe('Fix login');
  });

  it("mimocode's own first-sentence fallback, placeholders, child sessions and malformed payloads are not names", () => {
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_1', title: 'Say hi', titleSource: 'fallback' })).toBeNull();
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_1', title: 'New session - 2026-09-25T03:59:35.000Z' })).toBeNull();
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_2', parentID: 'ses_1', title: 'Explore auth code' })).toBeNull();
    expect(opencodeFamilyUpdatedTitle({ id: 'ses_1', title: { text: 'x' } })).toBeNull();
    expect(opencodeFamilyUpdatedTitle(null)).toBeNull();
  });
});
