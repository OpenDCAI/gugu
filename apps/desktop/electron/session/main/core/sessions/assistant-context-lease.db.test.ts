import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw Error('No fixture'); return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: state.emit } }));
import { abandonAssistantContextMigration, assistantConversationVersion, assistantContextMigrationHeld,
  ASSISTANT_CONTEXT_LEASE_MS, claimAssistantContextMigration, withAssistantContextAdmission } from './assistant-context-lease';
import { promoteAssistantContextCandidate } from './set-session-id';
import { setSessionLiveNotifier } from './session-message-router';

describe('assistant native context lease', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const source = '00000000-0000-4000-8000-000000000001';
  let lease: ReturnType<typeof claimAssistantContextMigration>;
  const row = () => fixture.sqlite.prepare('select * from sessions where id = ?').get('assistant') as { id: string; provider_session_id: string; config: string };
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.emit.mockClear();
    fixture.sqlite.exec(`INSERT INTO projects (id,name,path) VALUES ('project','Project','/repo');
      INSERT INTO sessions (id,project_id,title,provider,runtime,provider_session_id,agent_status,config)
      VALUES ('assistant','project','Assistant','claude','acp','${source}','idle','{"version":"1","type":"acp"}');`);
  });
  afterEach(() => { if (lease) abandonAssistantContextMigration(lease, 'Test finished'); setSessionLiveNotifier(null); fixture.close(); state.db = undefined; lease = null; vi.useRealTimers(); });

  it('atomically adopts only its reserved branch, retaining the original id and conversation identity', () => {
    lease = claimAssistantContextMigration('assistant', source)!;
    const version = assistantConversationVersion('assistant');
    expect(promoteAssistantContextCandidate({ ...lease, candidateProviderSessionId: 'unreserved', expectedVersion: version })).toBe(false);
    expect(promoteAssistantContextCandidate({ ...lease, expectedVersion: version })).toBe(true);
    const current = row(); const config = JSON.parse(current.config);
    expect(current.id).toBe('assistant'); expect(current.provider_session_id).toBe(lease.candidateProviderSessionId);
    expect(config.assistantContextMigration).toMatchObject({ state: 'completed', previousProviderSessionId: source });
    expect(config.assistantContextBranches).toEqual([source, lease.candidateProviderSessionId]);
    expect(state.emit).toHaveBeenCalledOnce();
    abandonAssistantContextMigration(lease, 'Released');
    expect(claimAssistantContextMigration('assistant', lease.candidateProviderSessionId)).toBeNull();
  });

  it('discards the candidate when any new durable input arrived after copying', () => {
    lease = claimAssistantContextMigration('assistant', source)!;
    const version = assistantConversationVersion('assistant');
    fixture.sqlite.prepare('insert into messages (id,session_id,content,sender) values (?,?,?,?)').run('new-message','assistant','New constraint','user');
    expect(promoteAssistantContextCandidate({ ...lease, expectedVersion: version })).toBe(false);
    expect(row().provider_session_id).toBe(source); expect(state.emit).not.toHaveBeenCalled();
  });

  it('does not copy while a native admission or a queued message is present', async () => {
    await withAssistantContextAdmission('assistant', async () => {
      expect(claimAssistantContextMigration('assistant', source)).toBeNull();
    });
    fixture.sqlite.prepare('insert into messages (id,session_id,content,sender,metadata) values (?,?,?,?,?)')
      .run('queued','assistant','New work','user','{"state":"queued"}');
    expect(claimAssistantContextMigration('assistant', source)).toBeNull();
  });

  it('automatically admits queued work after an expired/crashed lease and refuses late promotion', async () => {
    vi.useFakeTimers();
    const drain = vi.fn(); setSessionLiveNotifier(drain);
    lease = claimAssistantContextMigration('assistant', source)!;
    const expectedVersion = assistantConversationVersion('assistant');
    const admitted = vi.fn(async () => 'reply');
    const waiting = withAssistantContextAdmission('assistant', admitted);
    expect(admitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ASSISTANT_CONTEXT_LEASE_MS + 50);
    await expect(waiting).resolves.toBe('reply');
    expect(assistantContextMigrationHeld('assistant')).toBe(false);
    expect(drain).toHaveBeenCalledWith('assistant');
    expect(promoteAssistantContextCandidate({ ...lease, expectedVersion })).toBe(false);
    expect(row().provider_session_id).toBe(source);
  });

  it('a late old worker cannot release or adopt a newer lease', () => {
    const now = Date.now(); lease = claimAssistantContextMigration('assistant', source, now)!;
    const old = lease;
    lease = claimAssistantContextMigration('assistant', source, now + ASSISTANT_CONTEXT_LEASE_MS + 1)!;
    abandonAssistantContextMigration(old, 'Late failure');
    expect(JSON.parse(row().config).assistantContextMigration.token).toBe(lease.token);
    expect(promoteAssistantContextCandidate({ ...old, expectedVersion: assistantConversationVersion('assistant') })).toBe(false);
  });
});
