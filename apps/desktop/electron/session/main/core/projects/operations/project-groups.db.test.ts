// #7341 第二步 项目跨设备:会话页这一侧只答「项目在不在、叫什么、里面有哪些没归档的会话」,其余交给宿主;
// 改了东西就叫渲染层重读。打在真 SQLite 上,宿主用替身记下它收到了什么。
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@gugu/session-shared';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emitted: [] as { name: string; data: unknown }[],
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({
  events: {
    emit: (event: { name: string }, data: unknown) => mocks.emitted.push({ name: event.name, data }),
  },
}));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log };
});

import { setProjectGroupHost, type ProjectGroupHost, type ProjectGroupSubject } from '../project-group-host';
import { onActivitySignal } from '../../activity/signals';
import {
  bindProjectToGroup,
  ensureProjectGroup,
  listProjectGroupBindings,
  unbindProjectGroup,
} from './project-groups';

const BINDING_CHANGED = 'project:group-binding-changed';

type Call =
  | { op: 'list'; projectIds: readonly string[] }
  | { op: 'ensure'; subject: ProjectGroupSubject }
  | { op: 'bind'; subject: ProjectGroupSubject; chatId: string }
  | { op: 'unbind'; subject: ProjectGroupSubject };

function fakeHost(overrides: Partial<ProjectGroupHost> = {}): { host: ProjectGroupHost; calls: Call[] } {
  const calls: Call[] = [];
  const host: ProjectGroupHost = {
    listBindings: async (projectIds) => {
      calls.push({ op: 'list', projectIds });
      return ok(projectIds.map((projectId) => ({ projectId, chatId: `chat-of-${projectId}` })));
    },
    ensureGroup: async (subject) => {
      calls.push({ op: 'ensure', subject });
      return ok({ chatId: 'chat-reserved', changed: true });
    },
    bindToGroup: async (subject, chatId) => {
      calls.push({ op: 'bind', subject, chatId });
      return ok({ movedAgents: 2, previousChatId: 'chat-old', changed: true });
    },
    unbind: async (subject) => {
      calls.push({ op: 'unbind', subject });
      return ok({ changed: true });
    },
    ...overrides,
  };
  return { host, calls };
}

describe('project groups (会话页一侧)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emitted.length = 0;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-a', 'gugu', '/w/gugu');
      INSERT INTO projects (id, name, path) VALUES ('project-b', 'other', '/w/other');
      INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s-live-1', 'project-a', 'one', '2026-10-01 00:00:01');
      INSERT INTO sessions (id, project_id, title, created_at) VALUES ('s-live-2', 'project-a', 'two', '2026-10-01 00:00:02');
      INSERT INTO sessions (id, project_id, title, archived_at) VALUES ('s-archived', 'project-a', 'old', '2026-10-02');
      INSERT INTO sessions (id, project_id, title) VALUES ('s-other', 'project-b', 'elsewhere');
    `);
  });

  afterEach(() => {
    setProjectGroupHost(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('宿主没接上 ⇒ 响亮失败,❌ 当成「没有绑定」', async () => {
    await expect(listProjectGroupBindings()).rejects.toMatchObject({ code: 'host_not_ready' });
    await expect(ensureProjectGroup('project-a')).rejects.toMatchObject({ code: 'host_not_ready' });
  });

  it('records only changed project-group associations after the host commits them', async () => {
    let bound = false;
    const activity: string[] = [];
    const off = onActivitySignal(event => activity.push(event.kind));
    setProjectGroupHost(fakeHost({
      ensureGroup: async () => { const changed = !bound; bound = true; return ok({ chatId: 'chat-one', changed }); },
      unbind: async () => { const changed = bound; bound = false; return ok({ changed }); },
    }).host);
    try {
      await ensureProjectGroup('project-a'); await ensureProjectGroup('project-a');
      await unbindProjectGroup('project-a'); await unbindProjectGroup('project-a');
      expect((await bindProjectToGroup('missing', 'chat-one')).success).toBe(false);
      expect(activity).toEqual(['project.group_bound', 'project.group_unbound']);
    } finally { off(); }
  });

  it('读绑定:问的是这台机器上还在的每个本地项目', async () => {
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    const result = await listProjectGroupBindings();
    expect(calls).toEqual([{ op: 'list', projectIds: expect.arrayContaining(['project-a', 'project-b']) }]);
    expect((calls[0] as Extract<Call, { op: 'list' }>).projectIds).toHaveLength(2);
    expect(result).toEqual(ok(expect.arrayContaining([{ projectId: 'project-a', chatId: 'chat-of-project-a' }])));
  });

  it('#609 workspace 不问:它从前绑的群成了普通群,照常列在「聊天」里', async () => {
    fixture.sqlite.exec(`UPDATE projects SET kind = 'workspace' WHERE id = 'project-b'`);
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    await listProjectGroupBindings();
    expect(calls).toEqual([{ op: 'list', projectIds: ['project-a'] }]);
  });

  it('预留群:交给宿主的是项目名与没归档的会话;改了才叫渲染层重读,结果里不带 changed', async () => {
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    const result = await ensureProjectGroup('project-a');
    expect(result).toEqual(ok({ chatId: 'chat-reserved' }));
    expect(calls).toEqual([
      { op: 'ensure', subject: { projectId: 'project-a', projectName: 'gugu', sessionIds: ['s-live-1', 's-live-2'] } },
    ]);
    expect(mocks.emitted).toEqual([{ name: BINDING_CHANGED, data: { projectId: 'project-a' } }]);

    mocks.emitted.length = 0;
    setProjectGroupHost(fakeHost({ ensureGroup: async () => ok({ chatId: 'chat-reserved', changed: false }) }).host);
    await ensureProjectGroup('project-a');
    expect(mocks.emitted, '什么都没变 ⇒ 不叫').toEqual([]);
  });

  it('没有这个项目 ⇒ not-found,宿主一下都不问', async () => {
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    expect(await ensureProjectGroup('nope')).toMatchObject({ success: false, error: { type: 'not-found' } });
    expect(await bindProjectToGroup('nope', 'chat-x')).toMatchObject({ success: false, error: { type: 'not-found' } });
    expect(await unbindProjectGroup('nope')).toMatchObject({ success: false, error: { type: 'not-found' } });
    expect(calls).toEqual([]);
    expect(mocks.emitted).toEqual([]);
  });

  it('并进来:群 id 原样交给宿主,结果只回 movedAgents / previousChatId', async () => {
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    const result = await bindProjectToGroup('project-a', 'chat-target');
    expect(result).toEqual(ok({ movedAgents: 2, previousChatId: 'chat-old' }));
    expect(calls).toEqual([
      {
        op: 'bind',
        chatId: 'chat-target',
        subject: { projectId: 'project-a', projectName: 'gugu', sessionIds: ['s-live-1', 's-live-2'] },
      },
    ]);
    expect(mocks.emitted).toEqual([{ name: BINDING_CHANGED, data: { projectId: 'project-a' } }]);
  });

  it('宿主拒了(群不能用)⇒ 原样回错,不叫渲染层', async () => {
    const refusal = { type: 'group-unavailable' as const, chatId: 'chat-gone', message: '那个群已经归档了' };
    setProjectGroupHost(fakeHost({ bindToGroup: async () => err(refusal) }).host);
    expect(await bindProjectToGroup('project-a', 'chat-gone')).toEqual(err(refusal));
    expect(mocks.emitted).toEqual([]);
  });

  it('撤销:回 ok(),改了就叫渲染层重读', async () => {
    const { host, calls } = fakeHost();
    setProjectGroupHost(host);
    expect(await unbindProjectGroup('project-b')).toEqual(ok());
    expect(calls).toEqual([
      { op: 'unbind', subject: { projectId: 'project-b', projectName: 'other', sessionIds: ['s-other'] } },
    ]);
    expect(mocks.emitted).toEqual([{ name: BINDING_CHANGED, data: { projectId: 'project-b' } }]);
  });
});
