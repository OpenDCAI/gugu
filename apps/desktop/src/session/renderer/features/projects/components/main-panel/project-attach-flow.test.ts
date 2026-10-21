// #7341 第二步:往项目里挂一个文件夹时选哪条路;接进别的机器上的文件夹、撤销,都回到挂之前的样子。
import { describe, expect, it, vi } from 'vitest';
import { linkFolderOnMachine, planAttach, type FolderOnMachine, type LinkFolderDeps } from '@shared/core/projects/project-attach-flow';

const machines: Record<string, string | null> = { 'local-gugu': null, 'd22-gugu': 'd22', 'd22-memor': 'd22' };
const machineOf = (id: string) => machines[id] ?? null;
const inspectWith = (answer: FolderOnMachine) => vi.fn(async () => answer);

describe('planAttach', () => {
  it('attaches under the project’s copy on that machine without asking the machine anything else', async () => {
    const inspect = inspectWith({});
    const plan = await planAttach({ machine: 'd22', path: '/srv/x', memberIds: ['local-gugu', 'd22-gugu'], machineOf, inspect });
    expect(plan).toEqual({ kind: 'member', memberId: 'd22-gugu' });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('offers to merge when the folder is another project’s root on that machine', async () => {
    const plan = await planAttach({
      machine: 'd22',
      path: '/srv/memor/',
      memberIds: ['local-gugu'],
      machineOf,
      inspect: inspectWith({ existingProject: { id: 'd22-memor', path: '/srv/memor', name: 'memor' } }),
    });
    expect(plan).toEqual({ kind: 'merge', projectId: 'd22-memor', name: 'memor' });
  });

  it('refuses a folder already attached to another project there, instead of merging that whole project', async () => {
    const plan = await planAttach({
      machine: 'd22',
      path: '/srv/memor-docs',
      memberIds: ['local-gugu'],
      machineOf,
      // 那台机器说:这个文件夹挂在 memor 下(它的根是别的路径)。
      inspect: inspectWith({ existingProject: { id: 'd22-memor', path: '/srv/memor', name: 'memor' } }),
    });
    expect(plan).toEqual({ kind: 'taken', projectName: 'memor' });
  });

  it('links a folder that is nothing yet on that machine, asking that machine (not this one)', async () => {
    const inspect = inspectWith({});
    const plan = await planAttach({ machine: 'd22', path: '/srv/new', memberIds: ['local-gugu'], machineOf, inspect });
    expect(plan).toEqual({ kind: 'link' });
    expect(inspect).toHaveBeenCalledWith('d22', '/srv/new');
  });
});

function deps(overrides: Partial<LinkFolderDeps> = {}): LinkFolderDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureGroup: vi.fn(async (row: string) => {
      calls.push(`ensure ${row}`);
      return { success: true as const, data: { chatId: 'chat-gugu' } };
    }),
    createProjectOn: vi.fn(async (machine: string | null, path: string) => {
      calls.push(`create ${machine} ${path}`);
      return { projectId: 'd22-new', created: true };
    }),
    bind: vi.fn(async (machine: string | null, projectId: string, chatId: string) => {
      calls.push(`bind ${machine} ${projectId} ${chatId}`);
      return { success: true as const, data: { movedAgents: 0, previousChatId: null } };
    }),
    unbind: vi.fn(async (machine: string | null, projectId: string) => {
      calls.push(`unbind ${machine} ${projectId}`);
      return { success: true as const, data: undefined };
    }),
    deleteProject: vi.fn(async (projectId: string) => {
      calls.push(`delete ${projectId}`);
    }),
    sessionCountOf: () => 0,
    ...overrides,
  };
}

describe('linkFolderOnMachine', () => {
  it('reserves the group on the row’s machine, makes the folder a project there, and binds it to that group', async () => {
    const d = deps();
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    expect(linked.ok).toBe(true);
    expect(d.calls).toEqual(['ensure local-gugu', 'create d22 /srv/new', 'bind d22 d22-new chat-gugu']);
  });

  it('undo unbinds and removes the project this step created (still empty) — nothing extra is left in the sidebar', async () => {
    const d = deps();
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    if (!linked.ok) throw new Error('expected a link');
    expect(await linked.undo()).toBe(true);
    expect(d.calls.slice(-2)).toEqual(['unbind d22 d22-new', 'delete d22-new']);
  });

  it('undo keeps a project that already existed there (merged in, or the folder was already one)', async () => {
    const merged = deps();
    const fromMerge = await linkFolderOnMachine(merged, { rowId: 'local-gugu', machine: 'd22', path: '/srv/memor', existingProjectId: 'd22-memor' });
    if (!fromMerge.ok) throw new Error('expected a link');
    await fromMerge.undo();
    expect(merged.createProjectOn).not.toHaveBeenCalled();
    expect(merged.deleteProject).not.toHaveBeenCalled();

    const already = deps({ createProjectOn: vi.fn(async () => ({ projectId: 'd22-old', created: false })) });
    const reused = await linkFolderOnMachine(already, { rowId: 'local-gugu', machine: 'd22', path: '/srv/old' });
    if (!reused.ok) throw new Error('expected a link');
    await reused.undo();
    expect(already.deleteProject).not.toHaveBeenCalled();
  });

  it('undo keeps a created project once someone has started a session in it', async () => {
    let sessions = 0;
    const d = deps({ sessionCountOf: () => sessions });
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    if (!linked.ok) throw new Error('expected a link');
    sessions = 1;
    await linked.undo();
    expect(d.deleteProject).not.toHaveBeenCalled();
  });

  it('a failed bind leaves nothing behind and says so', async () => {
    const d = deps({ bind: vi.fn(async () => ({ success: false as const, error: { type: 'cloud-failed' } })) });
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    expect(linked).toEqual({ ok: false, error: { type: 'cloud-failed' } });
    expect(d.deleteProject).toHaveBeenCalledWith('d22-new');
  });

  it('stops before touching that machine when the group cannot be had', async () => {
    const d = deps({ ensureGroup: vi.fn(async () => ({ success: false as const, error: { type: 'not-signed-in' } })) });
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    expect(linked.ok).toBe(false);
    expect(d.createProjectOn).not.toHaveBeenCalled();
    expect(d.bind).not.toHaveBeenCalled();
  });

  it('a failed unbind is reported and keeps the project', async () => {
    const d = deps({ unbind: vi.fn(async () => ({ success: false as const, error: { type: 'not-signed-in' } })) });
    const linked = await linkFolderOnMachine(d, { rowId: 'local-gugu', machine: 'd22', path: '/srv/new' });
    if (!linked.ok) throw new Error('expected a link');
    expect(await linked.undo()).toBe(false);
    expect(d.deleteProject).not.toHaveBeenCalled();
  });
});
