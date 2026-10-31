// #7341 项目首页的文件夹卡与它的数据(product spec「项目首页」)。
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ProjectFolderCard, shortHome, FAN_MAX_ROWS, FAN_ROW_MAX, fanPlace } from './project-folder-card';
import { UNANSWERED_AFTER_MS, useProjectFolders, type ProjectFoldersState } from './project-folders';
import { machineRegistry } from '@renderer/lib/machine-routing';

const mocks = vi.hoisted(() => ({
  entries: new Map<string, Array<{ projectId: string; sessionId: string; group: 'working' | 'needs-you' | null; time: number; title: string }>>(),
  list: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  folderListeners: new Set<(data: { projectId: string }) => void>(),
  groupListeners: new Set<(data: { projectId: string }) => void>(),
  // #113 账号上记着的别的机器上的文件夹(machine:projectId → 那一份)。
  account: new Map<string, ProjectFolder[]>(),
  // 账号上那份在那台机器经连接答过之后没再变的机器(其余 = 账号上那份更新)。
  accountNotNewer: new Set<string>(),
}));

vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    accountFolders: (machine: string, projectId: string) => mocks.account.get(`${machine}:${projectId}`) ?? null,
    accountIsNewer: (machine: string) => !mocks.accountNotNewer.has(machine),
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { placement: { entries: mocks.entries } },
}));
vi.mock('@renderer/lib/chat/sender-avatar', () => ({
  senderAvatarUrl: (fromId: string) => `avatar:${fromId}`,
  subscribeSenderAvatars: () => () => {},
}));
vi.mock('@renderer/lib/ipc', () => {
  const ipc = {
  events: {
    // 按通道分开:「文件夹变了」只重读那个项目的,「项目群绑定变了」一律重读 —— 混在一起就分不出前者有没有挑项目。
    on: (channel: { name: string }, cb: (data: { projectId: string }) => void) => {
      const listeners = channel.name === 'project:group-binding-changed' ? mocks.groupListeners : mocks.folderListeners;
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  },
  rpc: {
    projects: {
      listProjectFolders: (...args: unknown[]) => mocks.list(...args),
      attachProjectFolder: (...args: unknown[]) => mocks.attach(...args),
      detachProjectFolder: (...args: unknown[]) => mocks.detach(...args),
    },
  },
};
  // 本机(null)那条线就是 events.on;测试里的项目都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
});

const folder = (workspaceId: string, kind: ProjectFolder['kind'], path: string, sessionIds: string[] = [], projectId = 'p1'): ProjectFolder => ({
  workspaceId,
  projectId,
  kind,
  path,
  branch: null,
  sessionIds,
  attachedAt: kind === 'root' ? null : new Date().toISOString(),
});
const shown = (...folders: ProjectFolder[]) => folders.map((f) => ({ ...f, offline: false, deviceId: null }));
const ROOT = folder('ws-root', 'root', '/www/gugu', ['s1']);
const WT = folder('ws-wt', 'attached', '/www/gugu-wt', ['s2']);
const OTHER = folder('ws-other', 'attached', '/www/gugu-supabase');
const EXTRA = folder('ws-extra', 'attached', '/www/gugu-web');

function stateOf(partial: Partial<ProjectFoldersState>): ProjectFoldersState {
  return {
    folders: shown(ROOT, WT, OTHER, EXTRA),
    loadError: false,
    unanswered: [],
    chosen: { ...ROOT, offline: false, deviceId: null },
    fresh: undefined,
    choose: vi.fn(),
    reload: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    ...partial,
  };
}

describe('ProjectFolderCard', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    container = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(container);
    setLocalePreference('zh-CN');
    mocks.entries.clear();
    mocks.list.mockReset();
    mocks.attach.mockReset();
    mocks.detach.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderCard(
    state: ProjectFoldersState,
    extra: {
      onAttach?: (machine: string | null) => void;
      onAddMachine?: () => void;
      onDropFolder?: (file: File) => void;
      memberIds?: string[];
      machines?: (string | null)[];
      machineOf?: (deviceId: string | null) => { label: string; online: boolean; kind: 'server' | 'computer' };
    } = {}
  ) {
    await act(async () => {
      root.render(
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement(ProjectFolderCard, {
            projectId: 'p1',
            projectName: 'gugu',
            folders: state,
            memberIds: extra.memberIds,
            machines: extra.machines ?? [null],
            machineOf: extra.machineOf ?? (() => ({ label: 'd22', online: true, kind: 'server' as const })),
            // 只有一台能挂:「+」直接去挑文件夹(多台时先弹机器菜单)。
            attachMachines: [{ id: null, label: '这台电脑', online: true, kind: 'computer' as const }],
            onAttach: extra.onAttach ?? vi.fn(),
            onAddMachine: extra.onAddMachine,
            onDropFolder: extra.onDropFolder ?? vi.fn(),
          })
        )
      );
    });
  }
  const papers = () => [...container.querySelectorAll<HTMLElement>('[data-testid="project-folder-paper"]')];
  const slotOf = (paper: HTMLElement) => paper.closest('.gg-folder-paper-slot') as HTMLElement;
  /** 露出来的那几页(收起时其余的透明地藏在叠底,仍在 DOM 里 —— 摊开才有过渡可走)。 */
  const visible = () => papers().filter((paper) => slotOf(paper).getAttribute('data-peek') === 'shown');
  const toggle = () => container.querySelector<HTMLElement>('[data-testid="project-folder-card-toggle"]');

  it('peeks the three most relevant folders: just attached, then the chosen one, then the root', async () => {
    await renderCard(stateOf({ chosen: { ...WT, offline: false, deviceId: null }, fresh: OTHER.workspaceId }));
    // 收起时只露三页,按相关程度:刚挂上的、选中的、根目录;第四页藏在叠底。
    expect(visible().map((p) => p.getAttribute('title'))).toEqual(['/www/gugu-supabase', '/www/gugu-wt', '/www/gugu']);
    expect(papers()).toHaveLength(4);
    // 最相关的那页压在最上面。
    const top = [...papers()].sort((a, b) => Number(slotOf(b).style.zIndex) - Number(slotOf(a).style.zIndex))[0];
    expect(top.getAttribute('title')).toBe('/www/gugu-supabase');
    expect(container.textContent).toContain('刚挂上');
    expect(container.textContent).toContain('4 个文件夹');
  });

  it('counts only this project’s own sessions, and how many are running', async () => {
    mocks.entries.set('p1', [
      { projectId: 'p1', sessionId: 's1', group: 'working', time: 2, title: 'a' },
      { projectId: 'p1', sessionId: 's2', group: null, time: 1, title: 'b' },
      // 别的项目的子会话挂在这一行下:不算这个项目的。
      { projectId: 'p2', sessionId: 's9', group: 'working', time: 3, title: 'c' },
    ]);
    await renderCard(stateOf({}));
    expect(container.textContent).toContain('2 个会话');
    expect(container.textContent).toContain('1 个在跑');
    expect(container.textContent).not.toContain('2 个在跑');
    // 在跑的那个会话从根目录开工 ⇒ 根目录那页写「1 个会话在这儿跑」。
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu')?.textContent).toContain('1 个会话在这儿跑');
    // 头像只来自这个项目自己的会话。
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src')).sort()).toEqual(['avatar:session:s1', 'avatar:session:s2']);
  });

  it('counts each session once and explains six visible agents plus two more', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      projectId: 'p1', sessionId: `s${i}`, group: null, time: 8 - i, title: `agent ${i}`,
    }));
    mocks.entries.set('p1', [...entries, entries[0]!]);
    await renderCard(stateOf({}));
    expect(container.textContent).toContain('8 个会话');
    expect(container.querySelectorAll('.gg-folder-card__agents img')).toHaveLength(6);
    expect(container.querySelector('.gg-folder-card__agents')?.getAttribute('title')).toBe('共 8 个 Agent');
    const more = container.querySelector('.gg-folder-card__more');
    expect(more?.textContent).toBe('共 8 位');
    expect(more?.getAttribute('aria-label')).toBe('另有 2 个 Agent');
    expect(more?.getAttribute('title')).toBe('agent 6\nagent 7');
  });

  it('says how many sessions started in a folder even when none is running, and drops the stale fresh mark', async () => {
    const stale = { ...OTHER, attachedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    await renderCard(stateOf({ folders: [...shown(ROOT, WT), { ...stale, offline: false, deviceId: null }], fresh: stale.workspaceId }));
    // WT 里开过一个会话、此刻歇着:写「1 个会话」,❌「还没有会话」。
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu-wt')?.textContent).toContain('1 个会话');
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu-supabase')?.textContent).toContain('还没有会话');
    // 十分钟前挂上的不再标「刚挂上」。
    expect(container.textContent).not.toContain('刚挂上');
  });

  it('marks each folder with its own machine, offline ones greyed, and lists every machine on the card', async () => {
    // 每页纸读它自己记着的那台(folder.deviceId),❌ 拿 projectId 反查。
    const remote = { ...folder('ws-d15', 'attached', '/srv/gugu', [], 'proj-on-d15'), offline: true, deviceId: 'd15' };
    await renderCard(stateOf({ folders: [...shown(ROOT), remote] }), {
      memberIds: ['p1', 'proj-on-d15'],
      machines: [null, 'd15'],
      machineOf: (deviceId) => (deviceId === 'd15' ? { label: 'd15', online: true, kind: 'server' } : { label: '这台电脑', online: true, kind: 'computer' }),
    });
    const d15Paper = papers().find((p) => p.getAttribute('title') === '/srv/gugu');
    expect(d15Paper?.textContent).toContain('d15');
    // 那台此刻答不上(列的是上次读到的):纸上那颗点灰掉。
    expect(d15Paper?.querySelector('.gg-folder-chip__dot')?.classList.contains('is-offline')).toBe(true);
    const foot = container.querySelector('.gg-folder-card__machines')?.textContent ?? '';
    expect(foot).toContain('这台电脑');
    expect(foot).toContain('d15');
  });

  it('spreads every folder on click, picks one, and closes again', async () => {
    const state = stateOf({});
    await renderCard(state);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(visible()).toHaveLength(3);
    const nodesBefore = papers();

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(visible()).toHaveLength(4);
    // 摊开不换节点、不挪顺序:同一批 DOM 节点原地变位置,浏览器才有过渡可走(挪动 / 新挂的节点会瞬移)。
    expect(papers().length).toBe(nodesBefore.length);
    expect(papers().every((paper, i) => paper === nodesBefore[i])).toBe(true);
    expect(container.textContent).toContain('再点卡片收起');

    const extra = papers().find((p) => p.getAttribute('title') === '/www/gugu-web');
    await act(async () => extra?.click());
    expect(state.choose).toHaveBeenCalledWith('ws-extra');
    // 点纸 ≠ 点卡片:选完仍摊开着,可以接着换。
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a click on a peeking paper while closed opens the card instead of choosing', async () => {
    const state = stateOf({});
    await renderCard(state);
    await act(async () => visible()[0]?.click());
    expect(state.choose).not.toHaveBeenCalled();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('the + button asks to attach without spreading the card', async () => {
    const onAttach = vi.fn();
    await renderCard(stateOf({}), { onAttach });
    await act(async () => container.querySelector<HTMLElement>('[data-testid="project-folder-attach"]')?.click());
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach).toHaveBeenCalledWith(null);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hands a dropped Finder folder to the caller, and ignores drags without files', async () => {
    const onDropFolder = vi.fn();
    await renderCard(stateOf({}), { onDropFolder });
    const card = container.querySelector('[data-testid="project-folder-card"]') as HTMLElement;
    const file = new dom.window.File([''], 'gugu-supabase');
    const drop = (types: string[], files: File[]) => {
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types, files } });
      card.dispatchEvent(event);
    };
    await act(async () => drop(['text/plain'], []));
    expect(onDropFolder).not.toHaveBeenCalled();
    await act(async () => drop(['Files'], [file]));
    expect(onDropFolder).toHaveBeenCalledWith(file);
  });

  it('shows loading instead of zero folders and waits before allowing the card to open', async () => {
    await renderCard(stateOf({ folders: null, chosen: null }));
    expect(container.textContent).toContain('正在读取文件夹');
    expect(container.textContent).not.toContain('0 个文件夹');
    await act(async () => container.querySelector<HTMLElement>('[data-testid="project-folder-card"]')?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');

    await renderCard(stateOf({ folders: shown(ROOT) }));
    expect(container.textContent).toContain('1 个文件夹');
    expect(container.textContent).not.toContain('正在读取文件夹');
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says it could not read the folders instead of passing the root off as all of them', async () => {
    const state = stateOf({ folders: null, chosen: null, loadError: true });
    await renderCard(state);
    expect(papers()).toHaveLength(0);
    expect(container.textContent).toContain('读不到这个项目的文件夹');
    expect(container.textContent).not.toContain('0 个文件夹');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === '重试');
    await act(async () => retry?.click());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });
});

describe('useProjectFolders', () => {
  let dom: JSDOM;
  let root: Root;
  let latest: ProjectFoldersState | null = null;

  function Probe({ projectId, members }: { projectId: string; members?: string[] }) {
    latest = useProjectFolders(projectId, members);
    return null;
  }

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    root = createRoot(dom.window.document.querySelector('#root') as HTMLDivElement);
    latest = null;
    mocks.list.mockReset();
    mocks.attach.mockReset();
    mocks.detach.mockReset();
    mocks.account.clear();
    mocks.accountNotNewer.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  const mount = async (projectId: string, members?: string[]) => {
    await act(async () => root.render(React.createElement(Probe, { projectId, members })));
  };

  it('does not reuse the previous project’s folders while the new project is loading', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-switch-from');
    const next = Promise.withResolvers<unknown>();
    mocks.list.mockReturnValue(next.promise);
    await mount('p-switch-to');
    expect(latest?.folders).toBeNull();
    expect(latest?.chosen).toBeNull();
    expect(latest?.loadError).toBe(false);
    await act(async () => next.resolve({ success: true, data: [OTHER] }));
    expect(latest?.folders).toEqual(shown(OTHER));
  });

  it('accepts a successfully detached project with zero folders', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [] });
    await mount('p-empty');
    expect(latest?.folders).toEqual([]);
    expect(latest?.chosen).toBeNull();
    expect(latest?.loadError).toBe(false);
  });

  it('defaults to the root folder and follows the choice', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT, WT] });
    await mount('p-choice');
    expect(latest?.folders).toEqual(shown(ROOT, WT));
    expect(latest?.chosen?.workspaceId).toBe('ws-root');
    // 第一次读到的不算「刚挂上」。
    expect(latest?.fresh).toBeUndefined();
    await act(async () => latest?.choose('ws-wt'));
    expect(latest?.chosen?.workspaceId).toBe('ws-wt');
  });

  it('marks a newly attached folder fresh and re-reads the list', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-attach');
    mocks.attach.mockResolvedValue({ success: true, data: OTHER });
    mocks.list.mockResolvedValue({ success: true, data: [ROOT, OTHER] });
    let outcome: unknown;
    await act(async () => {
      outcome = await latest?.attach('p-attach', '/www/gugu-supabase');
    });
    expect(mocks.attach).toHaveBeenCalledWith('p-attach', '/www/gugu-supabase');
    expect(outcome).toEqual({ ok: true, folder: OTHER });
    expect(latest?.fresh).toBe('ws-other');
    expect(latest?.folders).toEqual(shown(ROOT, OTHER));
  });

  it('passes a refused attach back as-is and marks nothing fresh', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-refused');
    const error = { type: 'belongs-to-other-project', projectId: 'p2', projectName: 'memor', message: 'taken' };
    mocks.attach.mockResolvedValue({ success: false, error });
    let outcome: unknown;
    await act(async () => {
      outcome = await latest?.attach('p-refused', '/x');
    });
    expect(outcome).toEqual({ ok: false, error });
    expect(latest?.fresh).toBeUndefined();
  });

  it('undoing an attach drops the choice back to the root', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT, WT] });
    await mount('p-detach');
    await act(async () => latest?.choose('ws-wt'));
    mocks.detach.mockResolvedValue({ success: true, data: undefined });
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await act(async () => {
      await latest?.detach(WT);
    });
    // 撤的是那个文件夹自己所属的本地项目(可能在别的机器上),❌ 一律当成这一行的。
    expect(mocks.detach).toHaveBeenCalledWith('p1', 'ws-wt');
    expect(latest?.chosen?.workspaceId).toBe('ws-root');
  });

  it('re-reads when the machine says this project’s folders changed (agent, another window, undo)', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-event');
    mocks.list.mockResolvedValue({ success: true, data: [ROOT, WT] });
    await act(async () => mocks.folderListeners.forEach((cb) => cb({ projectId: 'some-other-project' })));
    expect(latest?.folders).toEqual(shown(ROOT));
    await act(async () => mocks.folderListeners.forEach((cb) => cb({ projectId: 'p-event' })));
    expect(latest?.folders).toEqual(shown(ROOT, WT));
    // 别处(agent / 另一个窗口)挂上的,重读后多出来 ⇒ 同样标「刚挂上」、在卡上落进去。
    expect(latest?.fresh).toBe('ws-wt');
  });

  it('re-reads when a machine binds or unbinds a project to a group (another machine’s copy joins or leaves)', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-group');
    mocks.list.mockResolvedValue({ success: true, data: [ROOT, WT] });
    await act(async () => mocks.groupListeners.forEach((cb) => cb({ projectId: 'some-other-project' })));
    expect(latest?.folders).toEqual(shown(ROOT, WT));
  });

  // #7341 第二步:同一个项目在几台机器上各有一个本地项目(绑在同一个项目群上),卡片汇总它们的文件夹。
  const D15_ROOT = folder('ws-d15', 'root', '/srv/gugu', [], 'proj-on-d15');
  const listByProject = (table: Record<string, unknown>) => (projectId: string) =>
    projectId in table
      ? Promise.resolve(table[projectId])
      : Promise.reject(new Error(`no machine answers for ${projectId}`));

  it('merges the folders of the project’s copies on every machine, row root chosen first', async () => {
    mocks.list.mockImplementation(listByProject({ 'p-row': { success: true, data: [{ ...ROOT, projectId: 'p-row' }] }, 'proj-on-d15': { success: true, data: [D15_ROOT] } }));
    await mount('p-row', ['p-row', 'proj-on-d15']);
    expect(latest?.folders?.map((f) => f.workspaceId)).toEqual(['ws-root', 'ws-d15']);
    expect(latest?.chosen?.workspaceId).toBe('ws-root');
    await act(async () => latest?.choose('ws-d15'));
    // 选了 d15 上的文件夹:新会话开在那台的那个本地项目里。
    expect(latest?.chosen?.projectId).toBe('proj-on-d15');
  });

  // #113 那台机器离线时它的文件夹照账号上记着的那份:这一端从没读到过它也列得出来。
  const onD15 = () => machineRegistry.register('d15', ['proj-on-d15', 'proj-hung-d15']);
  afterEach(() => machineRegistry.forgetMachine('d15'));

  it('lists an offline machine’s folders from the account, marked offline, though this computer never read them', async () => {
    onD15();
    const D15_WT = folder('ws-d15-wt', 'attached', '/srv/gugu-wt', [], 'proj-on-d15');
    mocks.account.set('d15:proj-on-d15', [D15_ROOT, D15_WT]);
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] } }));
    await mount('p-off', ['p-off', 'proj-on-d15']);
    expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
      ['ws-root', false],
      ['ws-d15', true],
      ['ws-d15-wt', true],
    ]);
    expect(latest?.loadError).toBe(false);
    // PR4:每个文件夹盖上读它时那一台(这台电脑 = null),之后的机器标签、设备范围、在哪开工都读它。
    expect(latest?.folders?.map((f) => [f.workspaceId, f.deviceId])).toEqual([
      ['ws-root', null],
      ['ws-d15', 'd15'],
      ['ws-d15-wt', 'd15'],
    ]);
    // 同一个本地项目 id 之后被别的设备行登记了(同一台机器重新登记):读到的这一份不跟着改指。
    machineRegistry.register('d15-new', ['proj-on-d15']);
    expect(latest?.folders?.find((f) => f.workspaceId === 'ws-d15')?.deviceId).toBe('d15');
    machineRegistry.forgetMachine('d15-new');
  });

  it('a machine that stops answering shows what the account records, not the last read', async () => {
    onD15();
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] }, 'proj-on-d15': { success: true, data: [D15_ROOT] } }));
    await mount('p-off', ['p-off', 'proj-on-d15']);
    // d15 掉线前在那台机器上摘了根目录、挂了一个别的:账号上记着的是这一份。
    const D15_OTHER = folder('ws-d15-other', 'attached', '/srv/other', [], 'proj-on-d15');
    mocks.account.set('d15:proj-on-d15', [D15_OTHER]);
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] } }));
    await act(async () => latest?.reload());
    expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
      ['ws-root', false],
      ['ws-d15-other', true],
    ]);
  });

  it('a machine that stops answering right after a folder was attached keeps what it last answered while the account has not caught up', async () => {
    onD15();
    // 刚在 d15 上挂了一个文件夹,d15 答过了;它还没记到账号上(账号上那份在 d15 答过之后没变)就掉线了。
    const D15_NEW = folder('ws-d15-new', 'attached', '/srv/new', [], 'proj-on-d15');
    mocks.account.set('d15:proj-on-d15', [D15_ROOT]);
    mocks.accountNotNewer.add('d15');
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] }, 'proj-on-d15': { success: true, data: [D15_ROOT, D15_NEW] } }));
    await mount('p-off', ['p-off', 'proj-on-d15']);
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] } }));
    await act(async () => latest?.reload());
    expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
      ['ws-root', false],
      ['ws-d15', true],
      ['ws-d15-new', true],
    ]);
    // 对照:它后来记到账号上的是别的一份(账号上那份更新了)= 照账号上的。
    mocks.accountNotNewer.clear();
    mocks.account.set('d15:proj-on-d15', [D15_NEW]);
    await act(async () => latest?.reload());
    expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
      ['ws-root', false],
      ['ws-d15-new', true],
    ]);
  });

  it('without the account’s record, a machine that stops answering keeps what this page just showed, marked offline', async () => {
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] }, 'proj-on-d15': { success: true, data: [D15_ROOT] } }));
    await mount('p-off', ['p-off', 'proj-on-d15']);
    mocks.list.mockImplementation(listByProject({ 'p-off': { success: true, data: [{ ...ROOT, projectId: 'p-off' }] } }));
    await act(async () => latest?.reload());
    expect(latest?.folders?.find((f) => f.workspaceId === 'ws-d15')?.offline).toBe(true);
    expect(latest?.folders?.find((f) => f.workspaceId === 'ws-root')?.offline).toBe(false);
  });

  it('re-reads when the account’s record arrives after the card first rendered', async () => {
    onD15();
    mocks.list.mockImplementation(listByProject({}));
    await mount('proj-on-d15');
    expect(latest?.loadError).toBe(true);
    mocks.account.set('d15:proj-on-d15', [D15_ROOT]);
    await mount('proj-on-d15');
    expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([['ws-d15', true]]);
    expect(latest?.loadError).toBe(false);
  });

  // 一台掉线的机器,发给它的请求可能挂很久(连接还没断开):❌ 等齐了才画 —— 实机撞过整张卡停在「读取中」,
  // 连这台电脑自己的文件夹都不出来。
  const never = () => new Promise<never>(() => {});

  it('shows this computer’s folders without waiting for a machine that does not answer, then the account’s ones marked offline', async () => {
    onD15();
    mocks.account.set('d15:proj-hung-d15', [{ ...D15_ROOT, projectId: 'proj-hung-d15' }]);
    mocks.list.mockImplementation((projectId: string) =>
      projectId === 'p-here' ? Promise.resolve({ success: true, data: [{ ...ROOT, projectId: 'p-here' }] }) : never()
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await mount('p-here', ['p-here', 'proj-hung-d15']);
      expect(latest?.folders?.map((f) => f.workspaceId)).toEqual(['ws-root']);
      expect(latest?.loadError).toBe(false);
      expect(latest?.unanswered).toEqual(['proj-hung-d15']);
      await act(async () => vi.advanceTimersByTime(UNANSWERED_AFTER_MS));
      expect(latest?.unanswered).toEqual([]);
      expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
        ['ws-root', false],
        ['ws-d15', true],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a re-read keeps a slow machine’s folders listed instead of flashing them away, until the deadline', async () => {
    mocks.list.mockImplementation(listByProject({ 'p-slow': { success: true, data: [{ ...ROOT, projectId: 'p-slow' }] }, 'proj-on-d15': { success: true, data: [D15_ROOT] } }));
    await mount('p-slow', ['p-slow', 'proj-on-d15']);
    mocks.list.mockImplementation((projectId: string) =>
      projectId === 'p-slow' ? Promise.resolve({ success: true, data: [{ ...ROOT, projectId: 'p-slow' }] }) : never()
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => latest?.reload());
      expect(latest?.folders?.map((f) => [f.workspaceId, f.offline])).toEqual([
        ['ws-root', false],
        ['ws-d15', false],
      ]);
      await act(async () => vi.advanceTimersByTime(UNANSWERED_AFTER_MS));
      expect(latest?.folders?.find((f) => f.workspaceId === 'ws-d15')?.offline).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a machine that answers late on the first read is not taken for one that just joined', async () => {
    const late = Promise.withResolvers<unknown>();
    mocks.list.mockImplementation((projectId: string) =>
      projectId === 'p-first' ? Promise.resolve({ success: true, data: [{ ...ROOT, projectId: 'p-first' }] }) : late.promise
    );
    await mount('p-first', ['p-first', 'proj-on-d15']);
    expect(latest?.folders?.map((f) => f.workspaceId)).toEqual(['ws-root']);
    await act(async () => late.resolve({ success: true, data: [D15_ROOT] }));
    expect(latest?.folders?.map((f) => f.workspaceId)).toEqual(['ws-root', 'ws-d15']);
    expect(latest?.fresh).toBeUndefined();
  });

  it('accepts the final detach as an empty list and does not resurrect cached folders when offline', async () => {
    mocks.list.mockResolvedValue({ success: true, data: [ROOT] });
    await mount('p-final-detach');
    expect(latest?.folders).toHaveLength(1);
    mocks.list.mockResolvedValue({ success: true, data: [] });
    await act(async () => latest?.reload());
    expect(latest?.folders).toEqual([]);
    expect(latest?.loadError).toBe(false);
    expect(latest?.chosen).toBeNull();
    mocks.list.mockRejectedValue(new Error('offline'));
    await act(async () => latest?.reload());
    expect(latest?.folders).toEqual([]);
    expect(latest?.loadError).toBe(false);
  });

  it('reports a failed read instead of inventing a folder list', async () => {
    mocks.list.mockResolvedValue({ success: false, error: { type: 'not-found', message: 'no such project' } });
    await mount('p-missing');
    expect(latest?.folders).toBeNull();
    expect(latest?.chosen).toBeNull();
    expect(latest?.loadError).toBe(true);
  });
});

describe('shortHome', () => {
  it('writes the home prefix as ~ and leaves everything else alone', () => {
    expect(shortHome('/Users/apple/Desktop/projects/gugu')).toBe('~/Desktop/projects/gugu');
    expect(shortHome('/home/dev/repo')).toBe('~/repo');
    expect(shortHome('/root')).toBe('~');
    expect(shortHome('C:\\Users\\me\\code')).toBe('~\\code');
    // 只认整段前缀:/Users/applesauce 不是 /Users/apple 的家 —— 换的是它自己的家,不是截半个名字。
    expect(shortHome('/Users/applesauce/x')).toBe('~/x');
    expect(shortHome('/www/gugu')).toBe('/www/gugu');
    expect(shortHome('/rootless/x')).toBe('/rootless/x');
  });
});

describe('fanPlace', () => {
  const hand = (count: number, column = 960) =>
    Array.from({ length: count }, (_, slot) => fanPlace(slot, count, { column, paperW: 200, paperH: 64, key: `ws-${slot}` }));
  const rowSizes = (count: number, column = 960) => {
    const sizes = new Map<number, number>();
    for (const p of hand(count, column)) sizes.set(p.row, (sizes.get(p.row) ?? 0) + 1);
    return [...sizes.values()];
  };

  it('puts slot 0 (the chosen folder) in the front row, rightmost and on top of everything', () => {
    for (const count of [2, 6, 12, 20]) {
      const places = hand(count);
      expect(places[0].row).toBe(0);
      expect(places[0].z).toBe(Math.max(...places.map((p) => p.z)));
      const front = places.filter((p) => p.row === 0);
      expect(places[0].x).toBe(Math.max(...front.map((p) => p.x)));
    }
  });

  it('within a row the right paper covers the left one, and a front row covers every row behind it', () => {
    const places = hand(20);
    for (const row of new Set(places.map((p) => p.row))) {
      const inRow = places.filter((p) => p.row === row).sort((a, b) => a.x - b.x);
      expect(inRow.map((p) => p.z)).toEqual([...inRow.map((p) => p.z)].sort((a, b) => a - b));
    }
    const minFront = Math.min(...places.filter((p) => p.row === 0).map((p) => p.z));
    expect(Math.max(...places.filter((p) => p.row > 0).map((p) => p.z))).toBeLessThan(minFront);
  });

  it('holds at most six a row, split evenly, and never more than five rows', () => {
    expect(rowSizes(6)).toEqual([6]);
    expect(rowSizes(20)).toEqual([5, 5, 5, 5]);
    for (const column of [360, 480, 600, 960, 1400]) {
      for (const count of [1, 7, 13, 20]) {
        const sizes = rowSizes(count, column);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(FAN_ROW_MAX);
        expect(sizes.length).toBeLessThanOrEqual(FAN_MAX_ROWS);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a narrow column takes more rows instead of squeezing the names', () => {
    expect(rowSizes(20, 480).length).toBeGreaterThan(rowSizes(20, 1200).length);
  });

  it('back rows rise above the front row', () => {
    const places = hand(20);
    const lowest = (row: number) => Math.max(...places.filter((p) => p.row === row).map((p) => p.y));
    expect(lowest(1)).toBeLessThan(lowest(0));
  });

  it('the same folder lands in the same spot every time', () => {
    expect(fanPlace(3, 12, { column: 900, paperW: 200, paperH: 64, key: 'ws-a' })).toEqual(
      fanPlace(3, 12, { column: 900, paperW: 200, paperH: 64, key: 'ws-a' })
    );
  });
});
