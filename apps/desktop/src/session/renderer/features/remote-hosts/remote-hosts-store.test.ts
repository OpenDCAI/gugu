// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installRemoteHostsBridge, type RemoteHostDevice } from '@/session/shared/remote-hosts';
import {
  RemoteHostsStore,
  deviceIdFromRemoteKey,
  dialsAfter,
  isRemoteKey,
  linkNeedsReopen,
  machineConnectionState,
  remoteSessionKey,
} from './remote-hosts-store';

const device = (overrides: Partial<RemoteHostDevice> = {}): RemoteHostDevice => ({
  id: 'dev-1',
  label: 'Linux 3',
  isOnline: true,
  platform: 'linux',
  lastSeenAt: null,
  sessionDigest: null,
  directTerminal: true,
  ...overrides,
});

describe('侧栏那颗点:设备状况 + 到它任务页宿主的线(#6264 一套工作台)', () => {
  it('连上了 = 已连接;第一次连着还没拿到清单 = 正在连接', () => {
    expect(machineConnectionState({ device: device(), link: 'open', synced: true })).toBe('connected');
    expect(machineConnectionState({ device: device(), link: 'connecting', synced: false })).toBe('connecting');
  });

  it('连上过、线断了(在线却问不通)= 重连中;离线 = 离线', () => {
    expect(machineConnectionState({ device: device(), link: 'closed', synced: true })).toBe('reconnecting');
    expect(machineConnectionState({ device: device({ isOnline: false }), link: 'closed', synced: true })).toBe('offline');
  });

  it('#137 连上过的机器断了:每一次重连在飞(connecting)也是重连中,❌ 翻回已连接再翻回来', () => {
    // 机器停了之后到心跳租约过期的两分钟里,线在 closed(等退避)与 connecting(拨)之间来回走,读数不许跟着跳
    for (const link of ['closed', 'connecting'] as const) {
      expect(machineConnectionState({ device: device(), link, synced: true }), link).toBe('reconnecting');
      expect(machineConnectionState({ device: device({ isOnline: false }), link, synced: true }), link).toBe('offline');
    }
  });

  it('#137 没连上过的机器线没通:一直是正在连接,❌ 读成已连接', () => {
    for (const link of ['closed', 'connecting'] as const) {
      expect(machineConnectionState({ device: device(), link, synced: false }), link).toBe('connecting');
    }
  });

  it('那台机器上的咕咕 server 太旧(还不会一套工作台)= 版本太旧,❌ 退回旧界面', () => {
    expect(machineConnectionState({ device: device(), link: 'tooOld', synced: false })).toBe('outdated');
  });

  it('#6264 远程 SSH 的机器太旧(d22 原装 0.2.131):行状态是「版本太旧」,❌ 永远「重连中」', () => {
    // 设备连接开出太旧、正在替它升级
    expect(machineConnectionState({ device: device({ sshLink: 'updating' }), link: 'closed', synced: true })).toBe('updating');
    // 会话页宿主说太旧(SessionHostTooOldError),同时正在替它升级:说更具体的那个
    expect(machineConnectionState({ device: device({ sshLink: 'updating' }), link: 'tooOld', synced: false })).toBe('updating');
    // 升级没成
    expect(machineConnectionState({ device: device({ sshLink: 'outdated' }), link: 'closed', synced: true })).toBe('update-failed');
    // 远程隧道的机器太旧:照旧「版本太旧,空闲时自动更新」
    expect(machineConnectionState({ device: device({ directTerminal: false }), link: 'tooOld', synced: false })).toBe('outdated');
  });

  it('远程 SSH 要先登录:只看 SSH 那一条', () => {
    expect(machineConnectionState({ device: device({ sshLink: 'signInRequired' }), link: 'closed', synced: false })).toBe('sign-in');
  });
});

describe('protocol mismatch is terminal while the peer heartbeat remains online', () => {
  it.each(['desktop-too-old', 'server-too-old'] as const)('%s does not remain Connecting', kind => {
    expect(machineConnectionState({ device: device({ notices: [{ kind }] }), link: 'connecting', synced: false }))
      .toBe('outdated');
  });
});

describe('#137 重连提示里「第几次」的数', () => {
  it('每次从没在拨进到在拨算一次;同一次拨里线状态重复通知不算;连通了清零', () => {
    let dials = 0;
    const walk = (links: Array<'connecting' | 'closed' | 'open'>) => {
      let previous: 'connecting' | 'closed' | 'open' | null = null;
      return links.map((link) => {
        dials = dialsAfter(dials, previous, link);
        previous = link;
        return dials;
      });
    };
    expect(walk(['connecting', 'connecting', 'closed', 'connecting', 'closed', 'connecting', 'closed'])).toEqual([1, 1, 1, 2, 2, 3, 3]);
    expect(walk(['open'])).toEqual([0]);
  });

  it('那台机器读成离线时线还在隔一会儿拨:那些不算;回来之后从第一次数起,❌「第 125 次尝试」', () => {
    let dials = 3;
    let previous: 'connecting' | 'closed' | null = 'closed';
    for (const link of ['connecting', 'closed', 'connecting', 'closed'] as const) {
      dials = dialsAfter(dials, previous, link, false);
      previous = link;
    }
    expect(dials).toBe(0);
    expect(dialsAfter(dials, previous, 'connecting', true)).toBe(1);
  });

  it('设备行读成离线的那一刻就清零(没有线的通知也一样)', () => {
    const store = new RemoteHostsStore();
    store.start();
    let listed = [device({ id: 'dev-count' })];
    const listeners = new Set<() => void>();
    const off = installRemoteHostsBridge({
      listDevices: () => listed,
      subscribeDevices: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
      pickFolder: async () => null,
    } as never);
    try {
      store.dials.set('dev-count', 8);
      listed = [device({ id: 'dev-count', isOnline: false, directTerminal: false })];
      listeners.forEach((listener) => listener());
      expect(store.dialsSinceOpen('dev-count')).toBe(0);
    } finally {
      off();
    }
  });
});

describe('心跳说那台机器在时,线要不要现在重开', () => {
  const client = (state: 'open' | 'closed' | 'connecting', appVersion: string | null) => ({
    state: () => state,
    hello: () => ({ protocol: 3, appVersion }),
  });

  it('断着的线照旧重开', () => {
    expect(linkNeedsReopen(device(), 'closed', client('closed', null))).toBe(true);
  });

  it('does not reopen a rejected viewer version on every online heartbeat', () => {
    expect(linkNeedsReopen(device({ notices: [{ kind: 'desktop-too-old' }] }), 'closed', client('closed', null))).toBe(false);
    // An upgraded peer that no longer requires a newer viewer can reconnect normally.
    expect(linkNeedsReopen(device({ notices: [] }), 'closed', client('closed', null))).toBe(true);
  });

  it('对面太旧、设备行报的版本已经换了(咕咕 server 换完版):开着的旧线扔掉重开,❌ 等下一拍心跳', () => {
    expect(linkNeedsReopen(device({ version: '0.2.53' }), 'tooOld', client('open', '0.2.52'))).toBe(true);
  });

  it('版本没变(一直不升级的旧机器)、有一边不报版本、或对面不旧:开着的线不动', () => {
    expect(linkNeedsReopen(device({ version: '0.2.52' }), 'tooOld', client('open', '0.2.52'))).toBe(false);
    expect(linkNeedsReopen(device({ version: null }), 'tooOld', client('open', '0.2.52'))).toBe(false);
    expect(linkNeedsReopen(device({ version: '0.2.53' }), 'tooOld', client('open', null))).toBe(false);
    expect(linkNeedsReopen(device({ version: '0.2.53' }), 'open', client('open', '0.2.52'))).toBe(false);
    expect(linkNeedsReopen(device({ version: '0.2.53' }), 'connecting', client('connecting', '0.2.52'))).toBe(false);
  });

  it('刚从离线回来:正在开的那一次是离线时发的(对面没人接,要等满超时),作废重开;没回来过的照旧等它', () => {
    expect(linkNeedsReopen(device(), 'connecting', client('connecting', null), true)).toBe(true);
    expect(linkNeedsReopen(device(), 'connecting', client('connecting', null), false)).toBe(false);
    expect(linkNeedsReopen(device(), 'open', client('open', null), true)).toBe(false);
  });
});

// #113 没连着的机器:项目清单、群绑定、主目录照账号上记着的那份(设备行上带着),❌ 这台桌面从前问到过才有。
describe('没连着的机器照账号上记着的那份', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    localProjectId: 'acct-proj-1',
    name: 'repo',
    rootPath: '/srv/repo',
    createdAt: '2026-10-01T08:00:00.000Z',
    chatId: 'chat-repo',
    folders: [{ workspaceId: 'ws-acct-root', kind: 'root' as const, path: '/srv/repo', attachedAt: null }],
    ...overrides,
  });

  it('列出它的项目、并上它的群、认得它的主目录,这台桌面从没连上过它也一样', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { projectGroupsStore } = await import('@renderer/features/projects/stores/project-groups-store');
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const store = new RemoteHostsStore();
    store.start();
    const offline = device({ id: 'dev-acct-1', isOnline: false, projects: [record()], homeDir: '/home/alice' });
    let listed = [offline];
    const listeners = new Set<() => void>();
    const off = installRemoteHostsBridge({
      listDevices: () => listed,
      subscribeDevices: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
      pickFolder: async () => null,
    } as never);
    try {
      expect(appState.projects.projects.get('acct-proj-1')?.data).toMatchObject({
        id: 'acct-proj-1', name: 'repo', path: '/srv/repo', repositoryWorkspaceId: 'ws-acct-root', createdAt: '2026-10-01 08:00:00',
      });
      expect(machineRegistry.machineOf('acct-proj-1')).toBe('dev-acct-1');
      expect(projectGroupsStore.chatIdOf('acct-proj-1')).toBe('chat-repo');
      expect(store.homeDir('dev-acct-1')).toBe('/home/alice');
      expect(store.accountFolders('dev-acct-1', 'acct-proj-1')?.map((folder) => [folder.workspaceId, folder.kind, folder.branch])).toEqual([
        ['ws-acct-root', 'root', null],
      ]);

      // 那台机器离线时在它上面删了这个项目、建了另一个(它记到账号上,设备列表跟着刷新):这一端原地跟上。
      listed = [{ ...offline, projects: [record({ localProjectId: 'acct-proj-2', name: 'next', chatId: null, })] }];
      listeners.forEach((listener) => listener());
      expect(appState.projects.projects.has('acct-proj-1')).toBe(false);
      expect(appState.projects.projects.get('acct-proj-2')?.data?.name).toBe('next');
      expect(projectGroupsStore.chatIdOf('acct-proj-1')).toBeUndefined();

      // 账号上那份这一端还没读到(设备行上没带):❌ 拿空清单把侧栏里它的项目清掉。
      listed = [{ ...offline, projects: undefined }];
      listeners.forEach((listener) => listener());
      expect(appState.projects.projects.has('acct-proj-2')).toBe(true);
    } finally {
      off();
    }
  });
});

describe('键:机器选择器里认机器', () => {
  it('remote:<机器> 认得回机器', () => {
    expect(isRemoteKey(remoteSessionKey('dev-1'))).toBe(true);
    expect(deviceIdFromRemoteKey(remoteSessionKey('dev-1'))).toBe('dev-1');
    expect(isRemoteKey('p1')).toBe(false);
  });
});

describe('新建框用到的那几件(#6264)', () => {
  it('侧栏「+」的意图是被观察的:已经停在新建页时再点一次也看得见', async () => {
    const { autorun } = await import('mobx');
    const store = new RemoteHostsStore();
    const seen: Array<string | null> = [];
    const stop = autorun(() => {
      seen.push(store.newSessionTarget?.deviceId ?? null);
    });
    store.requestNewSession('dev-1', '/srv/app');
    expect(seen.at(-1)).toBe('dev-1');
    expect(store.takeNewSessionTarget()).toEqual({ deviceId: 'dev-1', projectPath: '/srv/app' });
    expect(seen.at(-1)).toBeNull();
    stop();
  });

  it('「添加一台机器」只在宿主给了入口时才有', () => {
    const store = new RemoteHostsStore();
    store.start();
    const bridge = { listDevices: () => [], subscribeDevices: () => () => {}, pickFolder: async () => null };
    const plain = installRemoteHostsBridge(bridge as never);
    expect(store.canAddMachine).toBe(false);
    plain();
    const openAddMachine = vi.fn();
    const withAdd = installRemoteHostsBridge({ ...bridge, openAddMachine } as never);
    expect(store.canAddMachine).toBe(true);
    store.openAddMachine();
    expect(openAddMachine).toHaveBeenCalledTimes(1);
    withAdd();
  });

  it('最近用过的文件夹按机器记,新的在前', () => {
    const store = new RemoteHostsStore();
    store.rememberRecentFolder('dev-1', '/srv/a');
    store.rememberRecentFolder('dev-1', '/srv/b');
    expect(store.recentFolders('dev-1')).toEqual(['/srv/b', '/srv/a']);
    expect(store.recentFolders('dev-2')).toEqual([]);
  });
});

// #6264 behavior gugu-server(owner 2026-09-25 选 A):新建时选了别的机器、没选项目 ⇒ 落在那台机器的主目录项目里,
// 那台机器上已有同路径项目就复用,否则建一个。
describe('没选项目 = 那台机器的主目录项目', () => {
  it('没有同路径项目:在那台机器上把主目录加成项目', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const store = new RemoteHostsStore();
    store.homeDirs = { 'dev-home-1': '/home/alice' };
    const create = vi.spyOn(appState.projects, 'createProject').mockResolvedValue('dev-home-1-project-home');
    const mount = vi.spyOn(appState.projects, 'ensureMounted').mockResolvedValue(undefined as never);

    await expect(store.ensureHomeProject('dev-home-1')).resolves.toBe('dev-home-1-project-home');
    expect(create).toHaveBeenCalledWith(
      { type: 'local', machine: 'dev-home-1' },
      expect.objectContaining({ mode: 'pick', path: '/home/alice', allowNonGit: true, automatic: true })
    );
    create.mockRestore();
    mount.mockRestore();
  });

  it('那台机器上已有同路径项目:复用,❌ 另建一个', async () => {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const store = new RemoteHostsStore();
    store.homeDirs = { 'dev-home-2': '/home/bob' };
    machineRegistry.register('dev-home-2', ['existing-home-project']);
    appState.projects.projects.set('existing-home-project', {
      id: 'existing-home-project',
      data: { path: '/home/bob/' },
    } as never);
    const create = vi.spyOn(appState.projects, 'createProject');
    const mount = vi.spyOn(appState.projects, 'ensureMounted').mockResolvedValue(undefined as never);

    await expect(store.ensureHomeProject('dev-home-2')).resolves.toBe('existing-home-project');
    expect(create).not.toHaveBeenCalled();
    appState.projects.projects.delete('existing-home-project');
    machineRegistry.forgetMachine('dev-home-2');
    create.mockRestore();
    mount.mockRestore();
  });
});

// #7016 @ 弹层与侧栏身份读会话目录,❌ 逐台机器去问:别的机器上的会话从目录来(行上带 agent id,名字与咕咕号
// 从身份缓存按 id 取);在线却还没读到会话列表的那台单独报出来,由弹层说「没读到」,❌ 拿空列表冒充「没有」。
describe('会话目录 → @ 与侧栏身份(directoryPeers)', () => {
  it('读到的那几台出行;在线却没读到的那台报「没读到」;读到了、真没有的那台 ❌ 报;离线的 ❌ 报', async () => {
    const { installIdentityDirectoryBridge, publishIdentityDirectory } = await import('@/lib/identityDirectoryBridge');
    installIdentityDirectoryBridge();
    const ensure = vi.fn();
    publishIdentityDirectory({ 'agent-b': { id: 'agent-b', display_name: 'Codex 8', gugu_number: 1208 } as never }, ensure);
    const store = new RemoteHostsStore();
    const { runInAction } = await import('mobx');
    const host = (id: string, isOnline: boolean, link: 'open' | 'connecting' | 'closed') =>
      runInAction(() => store.hosts.set(id, { device: device({ id, label: id, isOnline }), link, synced: link === 'open' }));
    host('dev-b', true, 'open');
    host('dev-c', true, 'connecting');
    host('dev-d', true, 'open');
    host('dev-e', false, 'closed');
    const session = (conversationId: string, agentUserId: string | null, harness = 'codex') =>
      ({ conversationId, harness, agent: agentUserId ? { userId: agentUserId } : null }) as never;
    runInAction(() => (store.directory = {
      'dev-b': { projects: [], sessions: [session('s-b1', 'agent-b'), session('s-b2', 'agent-unknown'), session('s-b3', null), session('s-b4', 'agent-b', 'claude'), session('s-b5', 'agent-b', 'future-harness')], cached: false, loading: false, error: null },
      'dev-d': { projects: [], sessions: [], cached: false, loading: false, error: null },
    }));

    const { peers, notRead } = store.directoryPeers();

    const codex8 = { users: { id: 'agent-b', display_name: 'Codex 8', gugu_number: 1208 } };
    // engine 按开户时同一个换法从 harness 换成 agent 类型(图标按它取);不认得的 harness 原样留着。
    expect(peers).toEqual([
      { sessionId: 's-b1', identity: codex8, engine: 'codex' },
      { sessionId: 's-b4', identity: codex8, engine: 'claude-code' },
      { sessionId: 's-b5', identity: codex8, engine: 'future-harness' },
    ]);
    // 身份缓存里还没有的那个 agent:交给缓存补取,这一轮不出行(❌ 拿 id 冒充名字)。
    expect(ensure).toHaveBeenCalledWith(['agent-unknown']);
    // 阴控:dev-c 在线、列表还没到 —— 必须报出来;dev-d 读到了、真的一条都没有,dev-e 离线,都不报。
    expect(notRead.map((d) => d.id)).toEqual(['dev-c']);
    publishIdentityDirectory(null, null);
  });
});

describe('#7158 gugu.showSession: the row the task list draws for another machine\'s session (listedProject)', () => {
  it('opens a home-workspace task from live events or an offline digest with the existing machine alias', async () => {
    const { sidebarStore } = await import('@renderer/lib/stores/app-state');
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const { runInAction } = await import('mobx');
    const store = new RemoteHostsStore();
    const home = '00000000-0000-4000-8000-000000000001';
    const row = (conversationId: string) => ({ conversationId, projectId: home, projectName: 'Tasks', title: 'task', harness: 'claude', runtime: 'acp' as const, agentStatus: null, lastInteractedAt: null, supported: true });
    runInAction(() => {
      store.hosts.set('home-live', { device: device({ id: 'home-live' }), link: 'open', synced: true });
      store.hosts.set('home-offline', { device: device({ id: 'home-offline', isOnline: false, sessionDigest: [row('off-task')] }), link: 'closed', synced: false });
      store.directory = { 'home-live': { projects: [], sessions: [row('live-task')], cached: false, loading: false, error: null } };
    });
    const before = sidebarStore.machines;
    sidebarStore.machines = {
      machineOf: (id) => machineRegistry.machineOf(id), label: () => null, homeDir: () => null,
      sessionsOf: (id) => store.sessionsOf(id),
    };
    try {
      expect(store.listedProject('live-task')).toBe(`${home}~home-live`);
      expect(store.listedProject('off-task')).toBe(`${home}~home-offline`);
      // A snapshot already translated at the RPC boundary stays translated once.
      runInAction(() => { store.directory = { 'home-live': { projects: [], sessions: [{ ...row('live-task'), projectId: `${home}~home-live` }], cached: false, loading: false, error: null } }; });
      expect(store.listedProject('live-task')).toBe(`${home}~home-live`);
    } finally {
      sidebarStore.machines = before;
    }
  });

  it('a listed row — live, or an offline machine\'s from its heartbeat — gives its project; one the list cannot place, none', async () => {
    const { sidebarStore } = await import('@renderer/lib/stores/app-state');
    const { runInAction } = await import('mobx');
    const store = new RemoteHostsStore();
    const HOME = '00000000-0000-4000-8000-000000000001';
    const digest = [{ conversationId: 's-off', projectId: 'p-off', projectName: 'off', title: 'off', harness: 'codex', agentStatus: null, lastInteractedAt: null, supported: true }];
    runInAction(() => {
      store.hosts.set('dev-b', { device: device({ id: 'dev-b' }), link: 'open', synced: true });
      store.hosts.set('dev-off', { device: device({ id: 'dev-off', isOnline: false, sessionDigest: digest }), link: 'closed', synced: false });
      store.directory = {
        'dev-b': { projects: [], sessions: [{ conversationId: 's-far', projectId: 'p-far' }, { conversationId: 's-home', projectId: HOME }] as never, cached: false, loading: false, error: null },
      };
    });
    // The sidebar's own reading of the machines (remoteHostsStore.start puts this one in): which project is on which machine.
    const before = sidebarStore.machines;
    sidebarStore.machines = {
      machineOf: (projectId) => ({ 'p-far': 'dev-b', 'p-off': 'dev-off' } as Record<string, string>)[projectId] ?? null,
      label: () => null,
      homeDir: () => null,
      sessionsOf: (deviceId) => store.sessionsOf(deviceId),
    };
    try {
      expect(store.listedProject('s-far')).toBe('p-far');
      expect(store.listedProject('s-off')).toBe('p-off');
      // In the directory, but in that machine's hidden home project: the list cannot place it, so neither does showSession.
      expect(store.findListedSession('s-home')).not.toBeNull();
      expect(store.listedProject('s-home')).toBeNull();
      expect(store.listedProject('s-nowhere')).toBeNull();
    } finally {
      sidebarStore.machines = before;
    }
  });
});

describe('#7199 打开云电脑上的会话:醒着也现问管家(设备表里的「醒着」可能还是睡下之前的)', () => {
  it('管家说它醒着时那一下没成:❌ 记成「没能唤醒」(没叫过它);睡着时叫醒没成照记', async () => {
    const store = new RemoteHostsStore();
    store.start();
    let devices = [device({ id: 'cloud', isOnline: false, cloudComputer: 'awake' })];
    const listeners = new Set<() => void>();
    const wakeCloudComputer = vi.fn(async () => {
      throw new Error('cloud-computer GET /state got no answer');
    });
    const off = installRemoteHostsBridge({
      listDevices: () => devices,
      subscribeDevices: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      pickFolder: async () => null,
      wakeCloudComputer,
    } as never);
    expect(await store.wakeCloudComputer('cloud')).toBe(false);
    expect(store.wakeFailure('cloud')).toBeNull();

    devices = [device({ id: 'cloud', isOnline: false, cloudComputer: 'asleep' })];
    for (const listener of listeners) listener();
    expect(await store.wakeCloudComputer('cloud')).toBe(false);
    expect(store.wakeFailure('cloud')).not.toBeNull();
    expect(wakeCloudComputer).toHaveBeenCalledTimes(2);
    off();
  });
});
