import { page } from '@vitest/browser/context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionHistoryDirectoryPage,
  SessionHistoryDirectoryParams,
  SessionHistoryDirectoryRow,
  SessionHistoryPage,
  SessionHistoryParams,
  SessionHistoryRow,
} from '@shared/core/session-history/session-history';
import { SESSION_HOME_SECTION_KEY } from '@shared/core/session-history/session-history';
import '@renderer/index.css';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listDirectories: vi.fn(),
  previewLocalSession: vi.fn(),
  importLocalSession: vi.fn(),
  navigate: vi.fn(),
  openSession: vi.fn(),
  ensureProjectLoaded: vi.fn(),
  restore: vi.fn(),
  remoteListDirectories: vi.fn(),
  remoteImport: vi.fn(),
  syncProjects: vi.fn(),
}));
// #6956 推到渲染层的事件:按机器分(与真 onMachineEvent 同一个判据,null = 本机),用例自己当主进程往里发。
const bus = vi.hoisted(() => ({
  listeners: new Set<{ machine: string | null; event: string; cb: (data: unknown) => void }>(),
}));
function emitFrom(machine: string | null, event: string, data: unknown): void {
  for (const l of [...bus.listeners]) if (l.machine === machine && l.event === event) l.cb(data);
}

vi.mock('@renderer/lib/ipc', () => {
  const rpc = {
    sessionHistory: { list: mocks.list, listDirectories: mocks.listDirectories },
    sessionImport: {
      previewLocalSession: mocks.previewLocalSession,
      importLocalSession: mocks.importLocalSession,
    },
  };
  return {
    rpc,
    // #6264 别的机器:那台机器上同一张路由表;这里只摆会话历史与导入两格。
    rpcOn: (machine: string | null) =>
      machine
        ? {
            sessionHistory: {
              list: mocks.list,
              listDirectories: (params: unknown) => mocks.remoteListDirectories(machine, params),
            },
            sessionImport: {
              previewLocalSession: mocks.previewLocalSession,
              importLocalSession: (params: unknown) => mocks.remoteImport(machine, params),
            },
          }
        : rpc,
    onMachineEvent: (machine: string | null, event: { name: string }, cb: (data: unknown) => void) => {
      const listener = { machine, event: event.name, cb };
      bus.listeners.add(listener);
      return () => bus.listeners.delete(listener);
    },
    events: { on: () => () => {}, emit: () => {} },
  };
});
// #6264 名下别的机器由用例自己摆(真 store 会去接 gugu 侧的设备通道):d22 用 SSH 装上、tunnel 只经远程隧道、off 离线。
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', async () => {
  const { observable } = await import('mobx');
  const device = (id: string, label: string, isOnline: boolean, directTerminal: boolean) => ({
    device: { id, label, isOnline, platform: 'linux', lastSeenAt: '2026-09-24T08:00:00Z', sessionDigest: null, directTerminal },
  });
  return {
    remoteHostsStore: {
      hosts: observable.map([
        ['dev-d22', device('dev-d22', 'd22', true, true)],
        ['dev-tunnel', device('dev-tunnel', 'tunnel', true, false)],
        ['dev-off', device('dev-off', 'off', false, true)],
      ]),
      start: () => {},
      device(id: string) {
        return (this.hosts.get(id) as { device: { directTerminal: boolean } } | undefined)?.device ?? null;
      },
      syncProjects: mocks.syncProjects,
      connectionState: () => 'connected',
      // #7199 选了睡着的云电脑才会叫醒 / 读叫醒没成的原因;这几台都不是云电脑。
      wakeCloudComputer: async () => false,
      wakeFailure: () => null,
    },
  };
});
// 真选择器(下拉菜单)的判据在它自己的用例里;这里只看页面把机器表交对了、选中后问的是谁。
vi.mock('@renderer/features/remote-hosts/machine-picker', () => ({
  MachinePicker: (props: {
    machines: Array<{ id: string; label: string; isOnline: boolean }>;
    selectedId: string;
    onSelect: (id: string) => void;
  }) => (
    <div data-testid="fake-device-picker" data-selected={props.selectedId}>
      {props.machines.map((d) => (
        <button key={d.id} type="button" data-testid={`pick-${d.id}`} onClick={() => props.onSelect(d.id)}>
          {d.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: mocks.openSession,
}));
vi.mock('@renderer/features/sessions/restore-session-flow', () => ({
  restoreArchivedSession: mocks.restore,
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ ensureProjectLoaded: mocks.ensureProjectLoaded }),
}));
// 节头的 agent 图标:真 AgentIcon 会把 agent store / 导航那整张图拉进来,这里只判「画了几个、id 对不对」。
vi.mock('@renderer/lib/components/agent-icon', () => ({
  AgentIcon: ({ id }: { id: string }) => <span data-testid="agent-icon" data-agent-id={id} />,
}));

import { setLocalePreference } from '@/i18n';
import { setPortalContainer } from '@renderer/lib/portal-container';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { SessionHistoryMainPanel } from '@renderer/features/session-history/session-history-view';

const NOW = Date.now();
const WEBAPP = '/Users/me/work/webapp';
const BILLING = '/Users/me/work/billing-service';

function gugu(overrides: Partial<SessionHistoryRow> & { key: string }): SessionHistoryRow {
  const sessionId = overrides.key.replace('gugu:', '');
  return {
    source: 'gugu',
    status: 'active',
    title: overrides.key,
    providerSessionId: null,
    providerId: 'claude',
    directory: WEBAPP,
    projectName: 'webapp',
    updatedAt: NOW - 3 * 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: NOW - 24 * 60 * 60 * 1000,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    gugu: { projectId: 'p1', sessionId, runtime: 'acp' },
    ...overrides,
  };
}

function local(overrides: Partial<SessionHistoryRow> & { key: string; title: string }): SessionHistoryRow {
  const providerSessionId = overrides.key.replace('local:', '');
  return {
    source: 'codex',
    status: 'not-imported',
    providerSessionId,
    providerId: 'codex',
    directory: BILLING,
    projectName: null,
    updatedAt: NOW - 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    local: {
      engine: 'codex',
      providerSessionId,
      title: overrides.title,
      cwd: BILLING,
      filePath: `/Users/me/.codex/sessions/${providerSessionId}.jsonl`,
      updatedAt: NOW - 60 * 60 * 1000,
      sizeBytes: 100,
    },
    ...overrides,
  };
}

// 顺序故意既不按时间也不按字母:渲染层若自作主张排序,DOM 顺序就会偏离主进程给的顺序。
const WEBAPP_ROWS: SessionHistoryRow[] = [
  gugu({ key: 'gugu:zebra', title: '整理 zebra 仓的发布脚本', status: 'archived', archivedAt: NOW - 1000, childCount: 2 }),
  gugu({ key: 'gugu:alpha', title: 'alpha 登录页主按钮的 hover 态', updatedAt: NOW - 10 * 60 * 60 * 1000, providerId: 'codex' }),
];
const BILLING_ROWS: SessionHistoryRow[] = [
  local({ key: 'local:codex-1', title: '给结算服务补幂等键' }),
  local({ key: 'local:codex-2', title: '把日志切成按天滚动' }),
];
const ROWS = [...WEBAPP_ROWS, ...BILLING_ROWS];

function dir(overrides: Partial<SessionHistoryDirectoryRow> & { key: string }): SessionHistoryDirectoryRow {
  return {
    directory: overrides.key || null,
    projectName: null,
    sessionCount: 2,
    countsBySource: { gugu: 0, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 0, archived: 0, 'not-imported': 2 },
    providers: ['codex'],
    updatedAt: NOW - 60 * 60 * 1000,
    lastPromptAt: null,
    addedAt: null,
    sessions: [],
    ...overrides,
  };
}

const DIRS: SessionHistoryDirectoryRow[] = [
  dir({
    key: WEBAPP,
    projectName: 'webapp',
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 0 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 0 },
    providers: ['claude', 'codex'],
    updatedAt: NOW - 3 * 60 * 60 * 1000,
    addedAt: NOW - 24 * 60 * 60 * 1000,
    sessions: WEBAPP_ROWS,
  }),
  dir({ key: BILLING, sessions: BILLING_ROWS }),
];

const DIRECTORIES = [
  { directory: WEBAPP, projectName: 'webapp', count: 2 },
  { directory: BILLING, projectName: null, count: 2 },
];

function pageOf(rows: SessionHistoryRow[], overrides: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return {
    rows,
    matched: rows.length,
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 2 },
    directories: DIRECTORIES,
    local: { discovered: 2, indexed: 2, pending: 0, stale: false },
    ...overrides,
  };
}

function directoryPageOf(
  rows: SessionHistoryDirectoryRow[],
  overrides: Partial<SessionHistoryDirectoryPage> = {}
): SessionHistoryDirectoryPage {
  return {
    rows,
    matched: rows.length,
    countsBySource: { gugu: 2, 'claude-code': 0, codex: 2 },
    countsByStatus: { active: 1, archived: 1, 'not-imported': 2 },
    directories: DIRECTORIES,
    local: { discovered: 2, indexed: 2, pending: 0, stale: false },
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(): void {
  container = document.createElement('div');
  container.className = 'emlight gugu-skin bg-background';
  container.style.height = '800px';
  document.body.appendChild(container);
  setPortalContainer(container);
  root = createRoot(container);
  root.render(
    <SessionLocalizationProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SessionHistoryMainPanel />
      </QueryClientProvider>
    </SessionLocalizationProvider>
  );
}

const screen = page;
const listParams = () => mocks.list.mock.calls.map(([params]) => params as SessionHistoryParams);
const directoryParams = () =>
  mocks.listDirectories.mock.calls.map(([params]) => params as SessionHistoryDirectoryParams);
const click = (testId: string) => (screen.getByTestId(testId).element() as HTMLElement).click();
/** 下拉 / 菜单是 Base UI:先点触发器,选项才渲染到 portal 里。 */
async function pick(triggerId: string, optionId: string): Promise<void> {
  click(triggerId);
  await expect.element(screen.getByTestId(optionId)).toBeVisible();
  click(optionId);
}
const keydown = (el: HTMLElement, key: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const rowKeys = () =>
  screen.getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-row-key'));

describe('会话历史(按目录分节)核心合同', () => {
  afterEach(() => {
    setPortalContainer(null);
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
  });

  beforeEach(async () => {
    await page.viewport(1280, 860);
    setLocalePreference('zh-CN');
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.list.mockResolvedValue(pageOf(ROWS));
    mocks.listDirectories.mockResolvedValue(directoryPageOf(DIRS));
    mocks.ensureProjectLoaded.mockResolvedValue(undefined);
    mocks.restore.mockResolvedValue(undefined);
    mocks.syncProjects.mockResolvedValue(undefined);
    mocks.remoteListDirectories.mockResolvedValue(directoryPageOf([dir({ key: '/home/alice/api', sessions: [local({ key: 'local:remote-1', title: 'd22 上聊过的一条' })] })]));
    mocks.remoteImport.mockImplementation((_machine: string, _params: { providerSessionId: string }) =>
      Promise.resolve({ projectId: 'rp', sessionId: 'rc', workingDirectory: '/home/alice/api', alreadyImported: false })
    );
    mocks.previewLocalSession.mockResolvedValue({
      sessionId: 'codex-1',
      title: BILLING_ROWS[0].title,
      cwd: BILLING,
      turnCount: 4,
      head: [],
      tail: [],
    });
  });

  it('默认一目录一节、全展开:节头有名字 / agent 图标 / 条数,节内按主进程给的顺序两行一条,动作按状态', async () => {
    render();
    const list = screen.getByTestId('session-history-list');
    await vi.waitFor(() => expect(list.getByTestId('session-history-section').all()).toHaveLength(2));
    const sections = list.getByTestId('session-history-section').all();
    expect(sections.map((s) => s.element().getAttribute('data-directory-key'))).toEqual([WEBAPP, BILLING]);
    await expect.element(list.getByText('webapp', { exact: true })).toBeVisible();
    // 节名 = 目录末级名(参照页就是一个词);完整路径在 title 上。
    await expect.element(list.getByText('billing-service', { exact: true })).toBeVisible();
    expect(
      list.getByTestId('session-history-section-name').all().map((el) => el.element().getAttribute('title'))
    ).toEqual([WEBAPP, BILLING]);
    // 节头的 agent 图标:webapp 那节两个 provider。
    expect(sections[0].getByTestId('session-history-section-agents').getByTestId('agent-icon').all().map((el) => el.element().getAttribute('data-agent-id'))).toEqual(['claude', 'codex']);
    await expect.element(sections[0].getByText('2 个会话', { exact: true })).toBeVisible();
    // 一次 RPC 把每节的会话一起带回(模板一节全列,上限 100),❌ 每节各拉一次;默认只看咕咕会话。
    // 每节随目录页只带回露出来的那几条(❌ 每节先拉上百条进内存)。
    expect(directoryParams()[0]).toMatchObject({ limit: 50, sessionsPerDirectory: 5, source: 'gugu' });
    expect(mocks.list).not.toHaveBeenCalled();

    // 节内的行:顺序照主进程给的,两行 = 标题 / 时间(模板),动作按状态;session id、父子范围只在详情里。
    expect(rowKeys()).toEqual(ROWS.map((row) => row.key));
    expect(screen.getByTestId('session-history-row').all().map((row) => row.element().getAttribute('data-status'))).toEqual([
      'archived', 'active', 'not-imported', 'not-imported',
    ]);
    expect(list.getByText('派出 2 个子任务', { exact: false }).all()).toHaveLength(0);
    // 第二行是模板写法的绝对时间(「2026年8月20日，19:46」)。
    expect(screen.getByTestId('session-history-row').first().element().querySelector('time')?.textContent).toMatch(
      /^\d{4}年\d{1,2}月\d{1,2}日，\d{1,2}:\d{2}$/
    );
    // 状态不另贴标签(动作钮就是状态),行上也没有勾选框。
    expect(list.getByText('已归档', { exact: true }).all()).toHaveLength(0);
    expect(screen.getByTestId('session-history-checkbox').all()).toHaveLength(0);
    const actions = list.getByTestId('session-history-action').all();
    expect(actions.map((action) => action.element().textContent)).toEqual(['恢复', '打开', '导入', '导入']);
    await expect.element(screen.getByTestId('session-history-total')).toHaveTextContent('共 2 个目录');
  });

  it('节头没有 ···;只看一节 = 顶上的项目下拉选中这个目录(同一份数据,按会话分页)', async () => {
    mocks.listDirectories.mockResolvedValue(directoryPageOf([{ ...DIRS[0], sessionCount: 30 }, DIRS[1]]));
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    // 一节被截断(webapp 30 条只带回 2 条)、一节全是未导入的(billing)—— 从前这两种节头都会长出 ···,现在都没有(owner 2026-09-26)。
    expect(screen.getByTestId('session-history-section-menu').all()).toHaveLength(0);
    await expect.element(screen.getByTestId('session-history-section-show-more')).toBeVisible();
    await pick('session-history-directory', `session-history-directory-${WEBAPP}`);
    await vi.waitFor(() => expect(listParams().some((p) => p.directory === WEBAPP && p.limit === 50)).toBe(true));
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(1));
    await expect.element(screen.getByTestId('session-history-total')).toHaveTextContent('共 4 条');
    await expect.element(screen.getByTestId('session-history-directory')).toHaveTextContent('webapp');

    // 目录下拉回到「所有目录」= 回到分节视图;「未关联目录」那一档给主进程的是 null。
    await pick('session-history-directory', 'session-history-directory-all');
    await vi.waitFor(() => expect(mocks.listDirectories.mock.calls.length).toBeGreaterThan(1));
    await pick('session-history-directory', 'session-history-directory-none');
    await vi.waitFor(() => expect(listParams().some((p) => p.directory === null)).toBe(true));
  });

  it('每节默认平铺露头几条、没有滚动条;点「显示更多」才变成限高小窗并当场要下一批,「收起」回去并扔掉多要来的', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => gugu({ key: `gugu:s${i}`, title: `s${i}` }));
    // 主进程按 sessionsPerDirectory 截:目录页里这一节只有头 5 条。
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([{ ...DIRS[0], sessionCount: 8, sessions: eight.slice(0, 5) }, DIRS[1]])
    );
    mocks.list.mockImplementation((params: SessionHistoryParams) =>
      Promise.resolve(pageOf(eight.slice(0, params.limit).map((row) => ({ ...row })), { matched: 8 }))
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    const sectionAt = (i: number) => screen.getByTestId('session-history-section').nth(i);
    const boxOf = (i: number) => sectionAt(i).getByTestId('session-history-section-box').element() as HTMLElement;
    const firstRows = () => sectionAt(0).getByTestId('session-history-row').all();

    // 默认:头 5 条平铺,不限高、不滚(❌ 一上来就是一排小窗);节下有「显示更多」,写着这一节一共几条。
    expect(firstRows()).toHaveLength(5);
    expect(getComputedStyle(boxOf(0)).maxHeight).toBe('none');
    expect(getComputedStyle(boxOf(0)).overflowY).toBe('visible');
    expect(boxOf(0).scrollHeight).toBeLessThanOrEqual(boxOf(0).clientHeight);
    await expect.element(sectionAt(0).getByTestId('session-history-section-show-more')).toHaveTextContent('显示更多（共 8 条）');
    // 两条的那节本来就全在,不给「显示更多」。
    expect(sectionAt(1).getByTestId('session-history-section-show-more').all()).toHaveLength(0);
    // 没点之前不去要这一节的更多(给观察器留足时间再判,❌ 判得太早假绿)。
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.list).not.toHaveBeenCalled();
    // 与咕咕其它清单同一套样子(ui-visual-spec §6.6 / §5.1):密度面板、无外框、6px 圆角、行间不画线。
    const panel = boxOf(0).parentElement as HTMLElement;
    expect(getComputedStyle(panel).borderTopWidth).toBe('0px');
    expect(getComputedStyle(panel).borderTopLeftRadius).toBe('6px');
    expect(getComputedStyle(panel).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    const item = screen.getByTestId('session-history-item').first().element() as HTMLElement;
    expect(getComputedStyle(item).borderBottomWidth).toBe('0px');

    // 显示更多:当场按这一节要下一批(同一套筛选 + 这一节,limit 放大,走本机索引缓存),这一节变成限高、能滚的小窗。
    (sectionAt(0).getByTestId('session-history-section-show-more').element() as HTMLElement).click();
    await vi.waitFor(() => expect(firstRows()).toHaveLength(8));
    expect(listParams().map((p) => [p.directory, p.limit, p.mode, p.source])).toEqual([[WEBAPP, 55, 'cached', 'gugu']]);
    expect(getComputedStyle(boxOf(0)).maxHeight).toBe('320px');
    expect(getComputedStyle(boxOf(0)).overflowY).toBe('auto');
    expect(getComputedStyle(boxOf(0)).getPropertyValue('scrollbar-width')).toBe('thin');
    expect(boxOf(0).scrollHeight).toBeGreaterThan(boxOf(0).clientHeight);
    const toggle = sectionAt(0).getByTestId('session-history-section-show-less');
    await expect.element(toggle).toHaveTextContent('收起');
    expect(toggle.element().getAttribute('aria-expanded')).toBe('true');
    // 只点开了这一节:别的节还是平铺。
    expect(getComputedStyle(boxOf(1)).maxHeight).toBe('none');
    // 这一节已全部带回 ⇒ 窗底没有加载哨兵。
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section-loading').all()).toHaveLength(0));

    // 收起:回到头 5 条平铺;多要来的那批扔掉了 —— 再点开会重新要(❌ 攥在内存里)。
    (toggle.element() as HTMLElement).click();
    await vi.waitFor(() => expect(firstRows()).toHaveLength(5));
    expect(getComputedStyle(boxOf(0)).maxHeight).toBe('none');
    (sectionAt(0).getByTestId('session-history-section-show-more').element() as HTMLElement).click();
    await vi.waitFor(() => expect(firstRows()).toHaveLength(8));
    expect(mocks.list).toHaveBeenCalledTimes(2);

    // 只看某一节:整页就是这一节,不限高,也没有「显示更多」。
    mocks.list.mockResolvedValue(pageOf(eight, { matched: 8 }));
    await pick('session-history-directory', `session-history-directory-${WEBAPP}`);
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(1));
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(8));
    expect(getComputedStyle(boxOf(0)).maxHeight).toBe('none');
    expect(screen.getByTestId('session-history-section-show-more').all()).toHaveLength(0);
    expect(screen.getByTestId('session-history-section-show-less').all()).toHaveLength(0);
  });

  it('要更多的那批还在路上就收起了:回来的那批不要,这一节停在头几条', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => gugu({ key: `gugu:p${i}`, title: `p${i}` }));
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([{ ...DIRS[0], sessionCount: 8, sessions: eight.slice(0, 5) }, DIRS[1]])
    );
    let resolveBatch: (page: SessionHistoryPage) => void = () => {};
    mocks.list.mockImplementation(() => new Promise<SessionHistoryPage>((resolve) => (resolveBatch = resolve)));
    render();
    const section = () => screen.getByTestId('session-history-section').first();
    await vi.waitFor(() => expect(section().getByTestId('session-history-row').all()).toHaveLength(5));
    (section().getByTestId('session-history-section-show-more').element() as HTMLElement).click();
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    (section().getByTestId('session-history-section-show-less').element() as HTMLElement).click();
    await vi.waitFor(() => expect(section().getByTestId('session-history-section-show-more').all()).toHaveLength(1));
    resolveBatch(pageOf(eight.map((row) => ({ ...row })), { matched: 8 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(section().getByTestId('session-history-row').all()).toHaveLength(5);
    const box = section().getByTestId('session-history-section-box').element() as HTMLElement;
    expect(getComputedStyle(box).maxHeight).toBe('none');
  });

  it('点开的小窗滚到底接着要这一节的下一批,一直滚到这一节全部带回', async () => {
    const all = Array.from({ length: 120 }, (_, i) => gugu({ key: `gugu:w${i}`, title: `w${i}` }));
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([{ ...DIRS[0], sessionCount: 120, sessions: all.slice(0, 5) }, DIRS[1]])
    );
    mocks.list.mockImplementation((params: SessionHistoryParams) =>
      // 行经 IPC 过来都是新对象(结构化克隆);mock 也给新对象,❌ 复用同一批引用 —— 那会把「按对象认光标」的毛病藏起来。
      Promise.resolve(pageOf(all.slice(0, params.limit).map((row) => ({ ...row })), { matched: 120 }))
    );
    render();
    const webappRows = () => screen.getByTestId('session-history-section').first().getByTestId('session-history-row').all();
    await vi.waitFor(() => expect(webappRows()).toHaveLength(5));
    click('session-history-section-show-more');
    await vi.waitFor(() => expect(webappRows()).toHaveLength(55));
    // 点开后那一批进来,窗底离得远:没滚到窗底之前不再要(给观察器留足回调的时间再判)。
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const box = () =>
      screen.getByTestId('session-history-section').first().getByTestId('session-history-section-box').element() as HTMLElement;
    const toBottom = () => {
      box().scrollTop = box().scrollHeight;
    };
    toBottom();
    await vi.waitFor(() => expect(webappRows()).toHaveLength(105));
    // 新一批进来,小窗停在原处接着往下翻(❌ 被拽回顶上:光标那条按行对象认时,每来一批都会被重新滚进视野)。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(box().scrollTop).toBeGreaterThan(0);
    toBottom();
    await vi.waitFor(() => expect(webappRows()).toHaveLength(120));
    // 每批 = 同一套筛选 + 这一节,limit 放大,走本机索引缓存。
    expect(listParams().map((p) => [p.directory, p.limit, p.mode, p.source])).toEqual([
      [WEBAPP, 55, 'cached', 'gugu'],
      [WEBAPP, 105, 'cached', 'gugu'],
      [WEBAPP, 155, 'cached', 'gugu'],
    ]);
    // 全部带回:哨兵收起,不再要。
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section-loading').all()).toHaveLength(0));
  });

  it('「咕咕独立会话」那一节:节名与下拉档名都是「咕咕独立会话」,不把内部 key 当路径露出来', async () => {
    const home = dir({ key: SESSION_HOME_SECTION_KEY, sessionCount: 1, sessions: [local({ key: 'local:th-1', title: '独立任务里跑的', directory: '/Users/me/gugu-a-profile/task-home' })] });
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([home, DIRS[1]], { directories: [...DIRECTORIES, { directory: SESSION_HOME_SECTION_KEY, projectName: null, count: 1 }] })
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    const name = screen.getByTestId('session-history-section-name').first();
    await expect.element(name).toHaveTextContent('咕咕独立会话');
    expect(name.element().getAttribute('title')).toBeNull();
    click('session-history-directory');
    const option = screen.getByTestId(`session-history-directory-${SESSION_HOME_SECTION_KEY}`);
    await expect.element(option).toHaveTextContent('咕咕独立会话');
    expect(option.element().textContent).not.toContain(SESSION_HOME_SECTION_KEY);
    (option.element() as HTMLElement).click();
    await vi.waitFor(() => expect(listParams().some((p) => p.directory === SESSION_HOME_SECTION_KEY)).toBe(true));
  });

  it('项目下拉列出全部目录,能按项目名或路径搜;选中 = 只看那一节', async () => {
    const facet = [
      ...DIRECTORIES,
      ...Array.from({ length: 40 }, (_, i) => ({ directory: `/tmp/scratch-${i}`, projectName: null, count: 1 })),
    ];
    mocks.listDirectories.mockResolvedValue(directoryPageOf(DIRS, { directories: facet }));
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    click('session-history-directory');
    const search = screen.getByTestId('session-history-directory-search');
    await expect.element(search).toBeVisible();
    // 全部列出:40 个 /tmp 目录 + 2 个项目 + 「所有项目」+「未关联目录」,❌ 截成前 24 个。
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="session-history-directory-/"]')).toHaveLength(42)
    );
    // 按路径搜(项目名里没有 work/):命中 webapp 与 billing-service 两档。
    await search.fill('work/');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="session-history-directory-/"]')).toHaveLength(2)
    );
    await search.fill('billing');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="session-history-directory-/"]')).toHaveLength(1)
    );
    click(`session-history-directory-${BILLING}`);
    await vi.waitFor(() => expect(listParams().some((p) => p.directory === BILLING)).toBe(true));
    await expect.element(screen.getByTestId('session-history-directory')).toHaveTextContent('billing-service');
  });

  it('筛选菜单(来源 / 状态 / 排序)与搜索都传给主进程,渲染层自己不排;触发钮写着生效的筛选', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(2));
    await expect.element(screen.getByTestId('session-history-filter')).toHaveTextContent('咕咕会话');
    await pick('session-history-filter', 'session-history-filter-source-codex');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.source === 'codex')).toBe(true));
    await pick('session-history-filter', 'session-history-filter-status-archived');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.status === 'archived')).toBe(true));
    await expect.element(screen.getByTestId('session-history-filter')).toHaveTextContent('Codex · 未导入 · 已归档');
    await pick('session-history-filter', 'session-history-filter-source-all');
    await vi.waitFor(() => expect(directoryParams().at(-1)?.source).toBeUndefined());
    await pick('session-history-filter', 'session-history-filter-sort-title');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.sort === 'title')).toBe(true));
    await screen.getByTestId('session-history-search').fill('幂等');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === '幂等')).toBe(true));
    // 排序键换了,DOM 顺序仍是主进程返回的顺序(mock 一直返回同一页)——渲染层没有自己排。
    expect(rowKeys()).toEqual(ROWS.map((row) => row.key));
  });

  it('滚动加载:目录多于已带回的,滚到底把 limit 放大交给主进程(❌ 翻页、❌ offset)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => dir({ key: `/d/${i}`, sessionCount: 1, sessions: [gugu({ key: `gugu:c${i}`, title: `c${i}`, directory: `/d/${i}` })] }));
    mocks.listDirectories.mockResolvedValue(directoryPageOf(many, { matched: 250 }));
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-section').all()).toHaveLength(50));
    expect(directoryParams().every((p) => p.limit === 50 && p.offset === undefined)).toBe(true);
    (screen.getByTestId('session-history-total').element().parentElement as HTMLElement).scrollIntoView();
    await vi.waitFor(() => expect(directoryParams().some((p) => p.limit === 100 && p.offset === undefined)).toBe(true));
    expect(screen.getByTestId('session-history-page').all()).toHaveLength(0);
  });

  it('点一行展开详情(咕咕行含 session id),再点收起;已归档的行:恢复走唯一路径并刷新', async () => {
    // 主进程的 restoreSession 每放回一条都发一次 archivedAt: null 的 session:changed;面板靠它刷新(#6956)。
    mocks.restore.mockImplementation(async (ref: { projectId: string; sessionId: string }) => {
      emitFrom(null, 'session:changed', { ...ref, changes: { archivedAt: null } });
    });
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([{ ...DIRS[0], sessions: [{ ...WEBAPP_ROWS[0], providerSessionId: 'sess-zebra-42' }, WEBAPP_ROWS[1]] }, DIRS[1]])
    );
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const first = screen.getByTestId('session-history-row').first();
    (first.element() as HTMLElement).click();
    await expect.element(screen.getByTestId('session-history-detail')).toBeVisible();
    await expect.element(screen.getByTestId('session-history-detail').getByText('sess-zebra-42')).toBeVisible();
    (first.element() as HTMLElement).click();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-detail').all()).toHaveLength(0));

    const callsBefore = mocks.listDirectories.mock.calls.length;
    (screen.getByTestId('session-history-action').first().element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 'zebra' })
    );
    await vi.waitFor(() => expect(mocks.listDirectories.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('#6956 面板开着时在别处归档(手机、侧栏、agent):跟着所看那台机器的 session:changed 重拉;别的字段、别的机器不重拉', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const calls = () => mocks.listDirectories.mock.calls.length;
    const before = calls();
    // 只改了标题;归档发生在别的机器上(这里看的是本机):都不重拉。
    emitFrom(null, 'session:changed', { sessionId: 'alpha', projectId: 'p1', changes: { title: '改了个名' } });
    emitFrom('dev-d22', 'session:changed', { sessionId: 'r1', projectId: 'rp', changes: { archivedAt: '2026-10-06 15:10:05' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls()).toBe(before);

    // 手机把 alpha 归档了:主进程发 archivedAt ⇒ 面板重拉,那一行的动作从「打开」换成「恢复」(❌ 还写着打开,点下去等满超时)。
    mocks.listDirectories.mockResolvedValue(
      directoryPageOf([
        { ...DIRS[0], sessions: [WEBAPP_ROWS[0], { ...WEBAPP_ROWS[1], status: 'archived', archivedAt: NOW }] },
        DIRS[1],
      ])
    );
    emitFrom(null, 'session:changed', { sessionId: 'alpha', projectId: 'p1', changes: { archivedAt: '2026-10-06 15:10:05' } });
    await vi.waitFor(() => expect(calls()).toBeGreaterThan(before));
    await vi.waitFor(() =>
      expect(screen.getByTestId('session-history-action').all().map((a) => a.element().textContent)).toEqual([
        '恢复', '恢复', '导入', '导入',
      ])
    );
  });

  it('活跃的行:打开 = 进这条会话并打开它', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-action').all()).toHaveLength(4));
    (screen.getByTestId('session-history-action').nth(1).element() as HTMLElement).click();
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'p1', sessionId: 'alpha' })
    );
    expect(mocks.openSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'alpha' }));
  });

  it('未导入的行:方向键 + 回车导入光标那条', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    mocks.importLocalSession.mockImplementation((_params: { providerSessionId: string }) =>
      Promise.resolve({
        projectId: 'p1', sessionId: 'c1', workingDirectory: '/w', alreadyImported: false,
      })
    );
    const searchEl = screen.getByTestId('session-history-search').element() as HTMLInputElement;
    searchEl.focus();
    // 光标从第一行(zebra)起:两下到 codex-1,两下之间等一帧 —— 同一帧里第二下读到的还是旧光标。
    keydown(searchEl, 'ArrowDown');
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('gugu:alpha'));
    keydown(searchEl, 'ArrowDown');
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('local:codex-1'));
    keydown(searchEl, 'Enter');
    await vi.waitFor(() =>
      expect(mocks.importLocalSession).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'codex-1', engine: 'codex' }))
    );
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'p1', sessionId: 'c1' }));

  });

  it('搜索词是某条的 session id 前缀:光标直接落在那条并上色', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const searchEl = screen.getByTestId('session-history-search').element() as HTMLInputElement;
    await screen.getByTestId('session-history-search').fill('codex-2');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === 'codex-2')).toBe(true));
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('local:codex-2'));
    const hit = screen.getByTestId('session-history-row').nth(3).element();
    expect(hit.getAttribute('data-row-key')).toBe('local:codex-2');
    expect(hit.className).toContain('bg-row-selected');
    // 短词只是普通关键词,不抢光标。
    await screen.getByTestId('session-history-search').fill('cod');
    await vi.waitFor(() => expect(directoryParams().some((p) => p.query === 'cod')).toBe(true));
    await vi.waitFor(() => expect(searchEl.getAttribute('aria-activedescendant')).toContain('gugu:zebra'));
  });

  it('#6264 标题右边选机器:选了 d22,目录页问的是 d22;导入建在 d22 上,进任务前先挂上 d22 的项目', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    const localCalls = mocks.listDirectories.mock.calls.length;
    click('pick-dev-d22');
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(1));
    expect(mocks.remoteListDirectories).toHaveBeenCalledWith('dev-d22', expect.objectContaining({ sessionsPerDirectory: 5 }));
    // 换过去之后本机那一路不再问;上一台的行 ❌ 留着冒充这一台的。
    expect(mocks.listDirectories.mock.calls.length).toBe(localCalls);
    expect(rowKeys()).toEqual(['local:remote-1']);
    click('session-history-action');
    await vi.waitFor(() =>
      expect(mocks.remoteImport).toHaveBeenCalledWith('dev-d22', expect.objectContaining({ providerSessionId: 'remote-1' }))
    );
    expect(mocks.importLocalSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'rp', sessionId: 'rc' }));
    expect(mocks.syncProjects).toHaveBeenCalledWith('dev-d22');
  });

  it('#6264 只经远程隧道连着的机器:导入的会话进「通用」(那种机器没有终端)', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    click('pick-dev-tunnel');
    await vi.waitFor(() => expect(rowKeys()).toEqual(['local:remote-1']));
    click('session-history-action');
    await vi.waitFor(() =>
      expect(mocks.remoteImport).toHaveBeenCalledWith('dev-tunnel', expect.objectContaining({ sessionView: 'general' }))
    );
  });

  it('#6264 选了离线的机器:只说它离线、上线后显示,不去问它', async () => {
    render();
    await vi.waitFor(() => expect(screen.getByTestId('session-history-row').all()).toHaveLength(4));
    click('pick-dev-off');
    await expect.element(screen.getByTestId('session-history-device-blocked')).toHaveTextContent('off 离线');
    expect(mocks.remoteListDirectories).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-history-row').all()).toHaveLength(0);
  });
});
