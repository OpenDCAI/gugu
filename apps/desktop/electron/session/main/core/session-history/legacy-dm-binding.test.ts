import { describe, expect, it, vi } from 'vitest';
import type { LocalAgentRecord } from '@gugu/core';
vi.mock('@main/db/client', () => ({ db: {} }));
const { legacyDmBinding } = await import('./legacy-dm-binding');

const record = (id: string, owner: string | undefined, session = 's1', extra: Partial<LocalAgentRecord> = {}): LocalAgentRecord => ({
  name: 'Same readable name', gugu_user_id: id, path: '/same/working/directory', prompt: '', agent_type: 'codex', created_at: 1,
  cache: { emdash_session_id: session, ...(owner ? { sessionpage_owner_user_id: owner } : {}) }, ...extra,
});
describe('read-only historical session binding', () => {
  it('requires the exact stored owner rather than guessing from name, directory or the current account', () => {
    expect(legacyDmBinding([record('a1', 'alice'), record('b1', 'bob')], 'alice', 's1')).toEqual({ agentUserId: 'a1', sessionId: 's1' });
    expect(legacyDmBinding([record('b1', 'bob'), record('unknown', undefined)], 'alice', 's1')).toBeNull();
    expect(legacyDmBinding([record('a1', 'alice', 's2')], 'alice', 's1')).toBeNull();
  });
  it('can read an archived parked binding without restoring or rewriting it', () => {
    const roster = [record('a1', 'alice', '', { status: 'archived', cache: { sessionpage_owner_user_id: 'alice', sessionpage_parked_session_id: 's1' } })];
    const before = JSON.stringify(roster);
    expect(legacyDmBinding(roster, 'alice', 's1')).toEqual({ agentUserId: 'a1', sessionId: 's1' });
    expect(JSON.stringify(roster)).toBe(before);
  });
  it('refuses ambiguous session identities and duplicate agent bindings', () => {
    expect(() => legacyDmBinding([record('a1', 'alice'), record('a2', 'alice')], 'alice', 's1')).toThrow(/more than one/);
    expect(() => legacyDmBinding([record('a1', 'alice'), record('a1', 'alice', 's2')], 'alice', 's1')).toThrow(/more than one/);
    expect(() => legacyDmBinding([], '', 's1')).toThrow(/signed-in owner/);
  });
});
