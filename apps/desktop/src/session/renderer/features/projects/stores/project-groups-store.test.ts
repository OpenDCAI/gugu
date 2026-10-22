// @vitest-environment jsdom
// #7341 第二步:每台机器上的本地项目绑哪个项目群。连着的机器各自回答;没连着的照账号上记着的那份(#113)——
// 那台机器离线,它上面的同一个项目照样并在原来那一行里(product spec:机器离线时文件夹照样列在项目里),❌ 拆成两行。
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

  // #113 没连着的机器:绑定照账号上记着的那份(远程主机那边交进来),这台电脑从没连上过它也一样。
  it('a machine that is not connected takes its bindings from the account’s record', async () => {
    answer('local', [{ projectId: 'local-shop', chatId: 'chat-shop' }]);
    const store = new ProjectGroupsStore();
    store.start(() => []);
    await settle();
    store.applyBindings('d22', [{ projectId: 'd22-shop', chatId: 'chat-shop', representative: true }]);
    expect(store.chatIdOf('local-shop')).toBe('chat-shop');
    expect(store.chatIdOf('d22-shop')).toBe('chat-shop');
    expect(store.isRepresentative('d22-shop')).toBe(true);
    // 账号上那份变了(在 d22 上撤销了并入):整份换掉。
    store.applyBindings('d22', []);
    expect(store.chatIdOf('d22-shop')).toBeUndefined();
    expect(store.isRepresentative('d22-shop')).toBe(false);
    expect(store.chatIdOf('local-shop')).toBe('chat-shop');
  });

  it('a machine that answers replaces what the account recorded for it — unbound there means unbound here', async () => {
    answer('local', []);
    answer('d22', []);
    const store = new ProjectGroupsStore();
    store.applyBindings('d22', [{ projectId: 'd22-shop', chatId: 'chat-shop' }]);
    store.start(() => ['d22']);
    await settle();
    expect(store.chatIdOf('d22-shop')).toBeUndefined();
  });

  it('nothing is remembered on this computer between runs (the account holds it)', async () => {
    answer('local', [{ projectId: 'z-target', chatId: 'chat-shared', representative: true }]);
    new ProjectGroupsStore().start(() => []);
    await settle();
    expect(localStorage.length).toBe(0);
  });
});
