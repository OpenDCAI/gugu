// @vitest-environment jsdom
// #7341 第二步:每台机器上的本地项目绑哪个项目群,记在这台电脑上 —— 下次打开时那台机器离线,它上面的同一个项目
// 照样并在原来那一行里(product spec:机器离线时文件夹照样列在项目里),❌ 一打开就拆成两行。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';
import { ProjectGroupsStore } from './project-groups-store';

const mocks = vi.hoisted(() => ({
  answers: new Map<string, () => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpcOn: (machine: string | null) => ({
    projects: {
      listProjectGroupBindings: () => (mocks.answers.get(machine ?? 'local') ?? (() => Promise.reject(new Error('offline'))))(),
    },
  }),
}));

const answer = (machine: string, bindings: ProjectGroupBinding[]) =>
  mocks.answers.set(machine, () => Promise.resolve({ success: true, data: bindings }));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('ProjectGroupsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.answers.clear();
  });

  it('keeps an offline machine’s binding from the last read across a restart', async () => {
    answer('local', [{ projectId: 'local-shop', chatId: 'chat-shop' }]);
    answer('d22', [{ projectId: 'd22-shop', chatId: 'chat-shop' }]);
    const before = new ProjectGroupsStore();
    before.start(() => ['d22']);
    await settle();
    expect(before.chatIdOf('d22-shop')).toBe('chat-shop');

    // 重开:d22 这次没连上(读它失败、也不在已同步的机器里)。
    mocks.answers.delete('d22');
    const after = new ProjectGroupsStore();
    after.start(() => []);
    await settle();
    expect(after.chatIdOf('local-shop')).toBe('chat-shop');
    expect(after.chatIdOf('d22-shop')).toBe('chat-shop');
  });

  it('a machine that answers replaces what was remembered for it — unbound there means unbound here', async () => {
    answer('local', []);
    answer('d22', [{ projectId: 'd22-shop', chatId: 'chat-shop' }]);
    new ProjectGroupsStore().start(() => ['d22']);
    await settle();

    answer('d22', []);
    const after = new ProjectGroupsStore();
    after.start(() => ['d22']);
    await settle();
    expect(after.chatIdOf('d22-shop')).toBeUndefined();
    // 记下的也跟着换了:再开一次、d22 又离线,也不再并进来。
    mocks.answers.delete('d22');
    const third = new ProjectGroupsStore();
    third.start(() => []);
    await settle();
    expect(third.chatIdOf('d22-shop')).toBeUndefined();
  });

  it('keeps the selected local representative when the app restarts before bindings refresh', async () => {
    answer('local', [
      { projectId: 'a-source', chatId: 'chat-shared', representative: false },
      { projectId: 'z-target', chatId: 'chat-shared', representative: true },
    ]);
    const before = new ProjectGroupsStore();
    before.start(() => []);
    await settle();
    expect(before.isRepresentative('z-target')).toBe(true);

    mocks.answers.delete('local');
    const after = new ProjectGroupsStore();
    after.start(() => []);
    await settle();
    expect(after.chatIdOf('a-source')).toBe('chat-shared');
    expect(after.isRepresentative('z-target')).toBe(true);
    expect(after.isRepresentative('a-source')).toBe(false);
  });
});
