import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #6615 问题 11 —— 程序凭 `gugu/sessionId` / `gugu/workspaceRoot` 知道调它的会话在哪儿干活。
 * 读的是这条会话**自己的**工作副本:库替身按 `eq` 真的过滤(两条会话同在,读错一条就红)。
 * App 面上的字段名仍是 sessionId(App 层那一刀改名),值是这条会话的 id。
 * 模型(`gugu/model`)是同一刻、同一份事实(session-model-fact.ts,真函数,不替身):咕咕的模型是 `platform:<id>`,
 * harness 自己的是它的 id,没决定过的是 null。
 */

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = { sessions: [] };
const mounted: Record<string, { path: string }> = {};
/** The per-session model decision (platform-model-selection's record): a Gugu model, a harness's own (null), or none. */
const decisions: Record<string, { modelId: string } | null | undefined> = {};

vi.mock('drizzle-orm', () => ({ eq: (column: { name: string }, value: unknown) => ({ column: column.name, value }) }));
vi.mock('@main/db/schema', () => ({
  sessions: { __table: 'conversations', id: { name: 'id' }, workspaceId: { name: 'workspaceId' }, projectId: { name: 'projectId' }, config: { name: 'config' } },
}));
vi.mock('@main/db/client', () => ({
  db: {
    select: (shape: Record<string, { name: string }>) => ({
      from: (table: { __table: string }) => ({
        where: (condition: { column: string; value: unknown }) => ({
          limit: async () =>
            rows[table.__table]!
              .filter((row) => row[condition.column] === condition.value)
              .map((row) => Object.fromEntries(Object.entries(shape).map(([key, column]) => [key, row[column.name]]))),
        }),
      }),
    }),
  },
}));
vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: { get: (key: string) => mounted[key] },
}));
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: async (sessionId: string) => decisions[sessionId],
}));

const { agentSessionContext } = await import('./extension-agent-context');

beforeEach(() => {
  rows.conversations = [
    { id: 'conv-a', workspaceId: 'ws-a', projectId: 'p-a', config: {} },
    { id: 'conv-b', workspaceId: 'ws-b', projectId: 'p-b', config: { model: 'gpt-5.5' } },
    { id: 'conv-nowhere', workspaceId: null, projectId: 'p-n', config: { model: 'opus-4-6' } },
    { id: 'conv-own-default', workspaceId: null, projectId: 'p-o', config: {} },
  ];
  for (const key of Object.keys(mounted)) delete mounted[key];
  mounted['ws-a'] = { path: '/work/a' };
  for (const key of Object.keys(decisions)) delete decisions[key];
  decisions['conv-a'] = { modelId: 'glm-5.3-flash' };
  decisions['conv-b'] = null;
  decisions['conv-own-default'] = null;
});

describe('agentSessionContext (#6615 问题 11)', () => {
  it("reads the caller's own session and its mounted working copy", async () => {
    expect(await agentSessionContext('conv-a')).toEqual({ sessionId: 'conv-a', projectId: 'p-a', workspaceId: 'ws-a', workspaceRoot: '/work/a', model: 'platform:glm-5.3-flash' });
  });

  it('a working copy that is not mounted is null — said, not borrowed from another session', async () => {
    expect(await agentSessionContext('conv-b')).toEqual({ sessionId: 'conv-b', projectId: 'p-b', workspaceId: 'ws-b', workspaceRoot: null, model: 'gpt-5.5' });
  });

  it('an unknown caller has no context; a session with no workspace yet leaves only its id', async () => {
    expect(await agentSessionContext('conv-nobody')).toBeNull();
    expect(await agentSessionContext('conv-nowhere')).toMatchObject({ sessionId: 'conv-nowhere', projectId: 'p-n', workspaceRoot: null });
  });

  it('the model gugu runs it on: a Gugu model as platform:<id>, a harness model as its id — never one it was not told', async () => {
    expect((await agentSessionContext('conv-a'))?.model).toBe('platform:glm-5.3-flash');
    expect((await agentSessionContext('conv-b'))?.model).toBe('gpt-5.5');
    // The harness's own, none pinned: null (the harness picks its default — gugu does not know which).
    expect((await agentSessionContext('conv-own-default'))?.model).toBeNull();
    // Never decided (a session from before the record): null, even with a model in its config — not guessed.
    expect((await agentSessionContext('conv-nowhere'))?.model).toBeNull();
  });
});
