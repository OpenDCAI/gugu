import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));

const { createAgent, updateAgent } = await import('@gugu/core/local/state/agents');
const { boundTaskName, setTaskNameOwner } = await import('./task-name');

let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'task-name-bound-')) };
});
afterEach(async () => {
  await setTaskNameOwner(null, env);
  await rm(env.GUGU_HOME!, { recursive: true, force: true });
});

const bind = (owner: string, sessionId: string, name: string, extra: Record<string, unknown> = {}) =>
  createAgent({
    name, agent_type: 'codex', path: '/w', prompt: '',
    gugu_user_id: `${owner}-${sessionId}`,
  }, env).then(() => updateAgent({ guguUserId: `${owner}-${sessionId}` }, {
    cache: { emdash_session_id: sessionId, sessionpage_owner_user_id: owner, ...extra },
  }, env));

describe('bound task names are a projection of the roster for the signed-in owner', () => {
  it('names a bound session by its identity, per owner, and follows every roster write', async () => {
    await bind('alice', 's1', 'Codex 3');
    await bind('bob', 's2', 'Bob agent');
    expect(boundTaskName('s1')).toBeUndefined(); // nobody signed in yet

    await setTaskNameOwner('alice', env);
    expect(boundTaskName('s1')).toEqual({ agentUserId: 'alice-s1', name: 'Codex 3', pending: false });
    expect(boundTaskName('s2')).toBeUndefined(); // another account's identity does not name it here

    await updateAgent({ guguUserId: 'alice-s1' }, { name: 'Parser', cache: { emdash_session_id: 's1', sessionpage_owner_user_id: 'alice', name_pending: true } }, env);
    expect(boundTaskName('s1')).toEqual({ agentUserId: 'alice-s1', name: 'Parser', pending: true });

    await setTaskNameOwner('bob', env);
    expect(boundTaskName('s1')).toBeUndefined();
    expect(boundTaskName('s2')?.name).toBe('Bob agent');

    await setTaskNameOwner(null, env);
    expect(boundTaskName('s2')).toBeUndefined();
  });

  it('an archived identity no longer names its session', async () => {
    await bind('alice', 's1', 'Codex 1');
    await setTaskNameOwner('alice', env);
    await updateAgent({ guguUserId: 'alice-s1' }, { status: 'archived' }, env);
    expect(boundTaskName('s1')).toBeUndefined();
  });
});
