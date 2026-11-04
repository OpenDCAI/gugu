import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));

const { createAgent, updateAgent, writeAgentName } = await import('@gugu/core/local/state/agents');
const { boundTaskName, hasPendingTaskNames, loadTaskNames, setTaskNameOwner } = await import('./task-name');

let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'task-name-bound-')) };
  await loadTaskNames(env);
});
afterEach(async () => {
  await rm(env.GUGU_HOME!, { recursive: true, force: true });
  await setTaskNameOwner(null, env); // an empty roster: no binding leaks into the next test
});

const bind = (owner: string, sessionId: string, name: string, extra: Record<string, unknown> = {}) =>
  createAgent({
    name, agent_type: 'codex', path: '/w', prompt: '',
    gugu_user_id: `${owner}-${sessionId}`,
  }, env).then(() => updateAgent({ guguUserId: `${owner}-${sessionId}` }, {
    cache: { emdash_session_id: sessionId, sessionpage_owner_user_id: owner, ...extra },
  }, env));

describe('bound task names are a projection of the whole roster', () => {
  it('names a bound session by its identity whoever is signed in, or nobody, and follows every roster write', async () => {
    await bind('alice', 's1', 'Codex 3');
    await bind('bob', 's2', 'Bob agent');
    // Boot before the sign-in arrives, or signed out: the roster still names every task.
    expect(boundTaskName('s1')).toMatchObject({ agentUserId: 'alice-s1', name: 'Codex 3' });
    expect(boundTaskName('s2')?.name).toBe('Bob agent');

    await setTaskNameOwner('alice', env);
    await writeAgentName('alice-s1', 'Parser', 'local', env);
    expect(boundTaskName('s1')).toEqual({ agentUserId: 'alice-s1', name: 'Parser', pending: true, ownerUserId: 'alice' });
    expect(hasPendingTaskNames()).toBe(true);

    // Switching account keeps the previous account's tasks named by their identities; publishing
    // pending names stays a sweep of the signed-in account.
    await setTaskNameOwner('bob', env);
    expect(boundTaskName('s1')?.name).toBe('Parser');
    expect(boundTaskName('s2')?.name).toBe('Bob agent');
    expect(hasPendingTaskNames()).toBe(false);
  });

  it('when two accounts bound an identity to one session, the signed-in account\'s names it', async () => {
    await bind('alice', 's1', 'Alice name');
    await bind('bob', 's1', 'Bob name');
    await setTaskNameOwner('alice', env);
    expect(boundTaskName('s1')?.name).toBe('Alice name');
    await setTaskNameOwner('bob', env);
    expect(boundTaskName('s1')?.name).toBe('Bob name');
  });

  it('an archived identity no longer names its session', async () => {
    await bind('alice', 's1', 'Codex 1');
    await setTaskNameOwner('alice', env);
    await updateAgent({ guguUserId: 'alice-s1' }, { status: 'archived' }, env);
    expect(boundTaskName('s1')).toBeUndefined();
  });
});
