import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showModal: vi.fn(),
  openWithDefaults: {} as Record<string, string>,
  activePaneOpen: vi.fn(),
  fileExists: vi.fn(),
  getHomeDirectory: vi.fn(),
  getSessionPageStore: vi.fn(),
  mountProject: vi.fn(),
  // 项目挂上之前没有 session manager(session-selectors 的 getSessionManagerStore 读的是 mountedProject)。
  projectMounted: false,
  provisionSession: vi.fn(),
  getSessionView: vi.fn(),
  openPath: vi.fn(),
  openIn: vi.fn(),
  paneLayoutOpen: vi.fn(),
  recordOutput: vi.fn(),
  showPage: vi.fn(),
  registerBrowser: vi.fn(),
  ensurePage: vi.fn(),
  resolveAttachmentPath: vi.fn(),
  registeredKinds: new Set<string>(),
  /** The kinds of the tabs already open in the session's panes. */
  openKinds: [] as string[],
  registerInstalledExtensionTabs: vi.fn(),
  statExternalFile: vi.fn(),
  toastError: vi.fn(),
  sessionFilePlace: vi.fn(),
  workspaceGet: vi.fn(),
  installedManifests: [] as Array<{
    id: string;
    contributes: { tabs: Array<{ name: string; title: string; opensFiles?: { session?: string[]; group?: string[] } }> };
  }>,
}));

vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({
  registerInstalledExtensionTabs: mocks.registerInstalledExtensionTabs,
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  asProvisioned: (session: unknown) => session,
  getSessionManagerStore: () => (mocks.projectMounted ? { provisionSession: mocks.provisionSession } : undefined),
  getSessionPageStore: mocks.getSessionPageStore,
  getSessionView: mocks.getSessionView,
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ mountProject: mocks.mountProject }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    browser: { registerSession: mocks.registerBrowser, ensureAgentPage: mocks.ensurePage },
    app: { getHomeDirectory: mocks.getHomeDirectory, openPath: mocks.openPath, openIn: mocks.openIn },
    sessionCreate: { resolveAttachmentPath: mocks.resolveAttachmentPath },
    extensions: { sessionFilePlace: mocks.sessionFilePlace },
    workspace: {
      files: { fileExists: mocks.fileExists, statExternalFile: mocks.statExternalFile },
    },
  },
}));

vi.mock('./workspace-registry', () => ({
  workspaceRegistry: { get: mocks.workspaceGet },
}));

vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: {
    get manifests() {
      return mocks.installedManifests;
    },
    get openWithDefaults() {
      return mocks.openWithDefaults;
    },
    isEnabled: () => true,
    noteOpenWithDefault: vi.fn(),
    locale: 'en-US',
  },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: mocks.showModal }));

const {
  makeFileLinkHandlers,
  openExternalFilePath,
  openFileBesideConversation,
  openFileInSessionEditor,
  openHostRequestedBrowserInSessionWhenReady,
  openHostRequestedExtensionInSessionWhenReady,
  openHostRequestedFileInSessionWhenReady,
} = await import('./open-file-in-file-editor');

describe('task file preview routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showPage.mockReset();
    mocks.installedManifests.length = 0;
    mocks.openWithDefaults = {};
    mocks.registeredKinds.clear();
    mocks.openKinds.length = 0;
    mocks.registerInstalledExtensionTabs.mockReset();
    const viewModel = {
      activePane: {
        open: mocks.activePaneOpen,
        registry: { has: (kind: string) => mocks.registeredKinds.has(kind) },
      },
      paneLayout: {
        open: mocks.paneLayoutOpen,
        windowPanes: new Map(),
        // No pane, unless a test lays out its panes itself or opens tabs (`mocks.openKinds`): one pane holding them.
        laidOut: null as unknown[] | null,
        get groups(): unknown[] {
          if (this.laidOut) return this.laidOut;
          if (mocks.openKinds.length === 0) return [];
          const tabs = mocks.openKinds.map((kind, index) => ({ tabId: `tab-${index}`, kind }));
          return [{ paneId: 'pane-1', pane: { entries: new Map(tabs.map((tab) => [tab.tabId, tab])), resolvedTabs: tabs } }];
        },
        set groups(value: unknown[]) {
          this.laidOut = value;
        },
      },
      recordOutput: mocks.recordOutput,
      showPage: mocks.showPage,
    };
    mocks.getSessionPageStore.mockReturnValue({ workspaceId: 'workspace-1', viewModel });
    mocks.getSessionView.mockReturnValue(viewModel);
    mocks.projectMounted = false;
    mocks.mountProject.mockImplementation(async () => {
      mocks.projectMounted = true;
    });
    mocks.provisionSession.mockResolvedValue(undefined);
    mocks.workspaceGet.mockReturnValue({ path: '/repo' });
    mocks.fileExists.mockResolvedValue({
      success: true,
      data: { exists: true, isDirectory: false },
    });
    mocks.statExternalFile.mockResolvedValue({
      success: true,
      data: { exists: true, isDirectory: false },
    });
    mocks.getHomeDirectory.mockResolvedValue('/Users/tester');
    mocks.openPath.mockResolvedValue({ success: true });
    mocks.openIn.mockResolvedValue({ success: true });
    // 默认:查不到副本就原样返回 —— 与主进程 `resolveAttachmentPath` 的兜底一致。
    mocks.resolveAttachmentPath.mockImplementation((_sessionId: string, target: string) =>
      Promise.resolve({ success: true, data: target })
    );
  });

  /**
   * 消息里那条 mention 指着**用户自己那个文件**(agent 要改的就是它),点开却不能跟着走它:
   * 它同时押在「文件还在不在」和「在不在 home 里」两件事上,而 home 之外 `openPath` 直接判死。
   * 存过副本就开副本 —— 这正是 #5269 最初那个「点了没反应」。
   */
  it('附件存过副本就打开副本,❌ 不打开 home 之外那条原路径', async () => {
    mocks.resolveAttachmentPath.mockResolvedValue({
      success: true,
      data: '/u/task-attachments/session-1/a1-report.pdf',
    });

    await openFileInSessionEditor('project-1', 'session-1', '/Volumes/SSD/report.pdf');

    // PDF 开在文件 tab 里(那张表里有它自己的渲染器),而路径指的是**副本**。
    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/u/task-attachments/session-1/a1-report.pdf', external: true },
        { preview: false }
      )
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('❌ 查不到副本就照旧指原路径 —— 工作区外的普通文件本来就该开它自己', async () => {
    // 阴控:上一条若是把所有路径都改写成副本,这一条会红。
    await openFileInSessionEditor('project-1', 'session-1', '/Volumes/SSD/report.pdf');

    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/Volumes/SSD/report.pdf', external: true },
        { preview: false }
      )
    );
  });

  /**
   * owner 2026-09-10:「文件我点击可以是 tab 打开吧」。三支各一条,判据是**开在哪儿**:
   * PDF/图片 → 浏览器 tab、文本 → 文件 tab、画不了的 → 系统默认程序。
   */
  it('压缩包这种谁都画不了的才交给系统默认程序', async () => {
    // 阴控:少了这条,一个「什么都塞进浏览器 tab」的实现照样全绿 —— 而 .zip 在那儿只会触发下载。
    await openFileInSessionEditor('project-1', 'session-1', '/Volumes/SSD/bundle.zip');

    // 第二个参数 undefined = 不声明属于哪个工作区(它在工作区外),主进程只认 home(#7191)。
    await vi.waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/Volumes/SSD/bundle.zip', undefined));
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
  });

  /**
   * 目录链接(聊天正文里点一个文件夹路径)开给系统文件管理器 —— 它自己的窗口才是「打开一个
   * 文件夹」的产品语义。塞进编辑器 tab 只会开出永远 Loading 的页签(2026-09-17 双平台实测)。
   */
  it('工作区内的目录链接交给系统文件管理器,❌ 不开编辑器页签', async () => {
    mocks.fileExists.mockResolvedValue({
      success: true,
      data: { exists: true, isDirectory: true },
    });

    await openFileInSessionEditor('project-1', 'session-1', 'linktest/folder');

    // openIn(finder) 而非 openPath:后者在主进程带 home jail,home 外的工作区目录会被拒。
    await vi.waitFor(() =>
      expect(mocks.openIn).toHaveBeenCalledWith({
        app: 'finder',
        path: '/repo/linktest/folder',
      })
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
  });

  it('工作区外的目录链接同样交给系统文件管理器(Windows 盘符与 POSIX 同一条路由)', async () => {
    mocks.statExternalFile.mockResolvedValue({
      success: true,
      data: { exists: true, isDirectory: true },
    });

    await openFileInSessionEditor('project-1', 'session-1', 'C:\\Users\\Jeffry\\gugu-linktest\\folder');

    await vi.waitFor(() =>
      expect(mocks.openIn).toHaveBeenCalledWith(
        expect.objectContaining({ app: 'finder', path: 'C:\\Users\\Jeffry\\gugu-linktest\\folder' })
      )
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
  });

  /**
   * 工作区外的缺失文件此前开出永远 Loading 的外部 tab(2026-09-17 实测,win 上 POSIX 形态必现)。
   * 点开一个不存在的路径要报人话,❌ 不许挂着 Loading 装作在打开。
   */
  it('工作区外的缺失文件报 fileNotFound toast,❌ 不开外部 tab', async () => {
    mocks.statExternalFile.mockResolvedValue({
      success: true,
      data: { exists: false, isDirectory: false },
    });

    await openFileInSessionEditor('project-1', 'session-1', '/tmp/gugu-linktest/b.md');

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  /**
   * `~/x` 必须先展开成家目录绝对路径再走路由 —— 不展开的话它被当工作区相对路径拼成
   * `<ws>/~/…`,报一条指向不存在位置的误导 toast(2026-09-17 双平台实测)。
   */
  it('~/ 路径先展开成家目录绝对路径,❌ 不当工作区相对路径拼接', async () => {
    await openFileInSessionEditor('project-1', 'session-1', '~/gugu-linktest/b.md');

    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/Users/tester/gugu-linktest/b.md', external: true },
        { preview: false }
      )
    );
    // 展开发生在拼工作区之前:fileExists 永远不该收到带 ~ 的路径。
    const fileExistsArgs = mocks.fileExists.mock.calls.map((call) => call[2]);
    expect(fileExistsArgs.every((path) => !path.includes('~'))).toBe(true);
  });

  it('external 路由同样展开 ~/ —— 终端链接检测把 ~ 前缀标成 external 走到这儿', async () => {
    await openExternalFilePath('project-1', 'session-1', '~/gugu-linktest/b.md');

    // 不展开的话会拿字面 `~/…` 开外部页签,而 readExternalFile 只收绝对路径,必出坏页签。
    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/Users/tester/gugu-linktest/b.md', external: true },
        { preview: false }
      )
    );
  });

  it('getHomeDirectory 一次瞬时失败不污染会话 —— 缓存被释放,下次点击即恢复', async () => {
    // 模块级 home 缓存跨用例存活:前面的用例已把它焐热,这里必须重置模块拿冷缓存,
    // 否则 rejected 分支根本不会走到,Once mock 还会漏给后面的用例(实测就是这么红的)。
    vi.resetModules();
    const { openFileInSessionEditor: openFresh } = await import('./open-file-in-file-editor');
    mocks.getHomeDirectory.mockRejectedValueOnce(new Error('bridge not ready'));
    // 第一次:~ 没展开,被当相对路径拼成 <ws>/~/… —— 那个位置不存在(只对这一次 mock)。
    mocks.fileExists.mockResolvedValueOnce({
      success: true,
      data: { exists: false, isDirectory: false },
    });

    await openFresh('project-1', 'session-1', '~/gugu-linktest/b.md');
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled());

    await openFresh('project-1', 'session-1', '~/gugu-linktest/b.md');
    // 第二次必须已经展开 —— rejected promise 被 cache 住的话这一步还是 toast。
    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/Users/tester/gugu-linktest/b.md', external: true },
        { preview: false }
      )
    );
  });

  it('stat 不可用(工作区已不在)时外部文件照旧走原路由,❌ 不静默吞掉点开', async () => {
    mocks.statExternalFile.mockResolvedValue(null);

    await openFileInSessionEditor('project-1', 'session-1', '/Volumes/SSD/report.pdf');

    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/Volumes/SSD/report.pdf', external: true },
        { preview: false }
      )
    );
  });


  /**
   * 「未选择项目」建出来的任务没有工作区面板,可它照样附得了文件(#5269)。这条从前是
   * **静默 return** —— owner 点消息里那枚 .pdf chip 什么都没发生、也没有任何报错。
   */
  it('没有可用面板时,.md 交给系统默认程序 —— ❌ 不许静默什么都不做', async () => {
    mocks.getSessionPageStore.mockReturnValue(undefined);
    mocks.getSessionView.mockReturnValue(undefined);

    await openExternalFilePath('project-1', 'session-1', '/u/task-attachments/session-1/a1-notes.md');

    await vi.waitFor(() =>
      expect(mocks.openPath).toHaveBeenCalledWith('/u/task-attachments/session-1/a1-notes.md', undefined)
    );
  });

  it('有面板时 .md 仍然开在面板里(反向对照:上一条不能把所有 .md 都推给系统)', async () => {
    await openExternalFilePath('project-1', 'session-1', '/u/task-attachments/session-1/a1-notes.md');

    await vi.waitFor(() =>
      expect(mocks.activePaneOpen).toHaveBeenCalledWith(
        'file',
        { path: '/u/task-attachments/session-1/a1-notes.md', external: true },
        { preview: false }
      )
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('lets a claiming extension take a clicked file', async () => {
    // 人点这条路的「认领」此前没有判据 —— 于是把认领逻辑挪进解析层时,变异只打红了
    // agent 那条,人点那条静静地保持绿色。补上它,「两条路共用一处」才是可证伪的。
    mocks.installedManifests.push({
      id: 'sheets',
      contributes: { tabs: [{ name: 'grid', title: 'Grid', opensFiles: { session: ['.csv'] } }] },
    });

    await openFileInSessionEditor('project-1', 'session-1', 'data/report.csv');

    await vi.waitFor(() =>
      expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
        'sheets.grid',
        { filePath: '/repo/data/report.csv' },
        { preview: false }
      )
    );
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
  });

  it('a link with a place: the App that takes the file is told it, by plain ids, before its tab opens', async () => {
    mocks.installedManifests.push({
      id: 'paper-club',
      contributes: { tabs: [{ name: 'reader', title: 'Reader', opensFiles: { session: ['.pdf'] } }] },
    });
    mocks.sessionFilePlace.mockResolvedValue({ success: true });

    makeFileLinkHandlers('project-1', 'session-1').onOpenFile('论文/a.pdf', { page: '4', h: 'h1' });

    await vi.waitFor(() => expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('paper-club.reader', { filePath: '/repo/论文/a.pdf' }, { preview: false }));
    const [args] = mocks.sessionFilePlace.mock.calls[0]!;
    expect(args).toEqual({ sessionId: 'session-1', filePath: '/repo/论文/a.pdf', extensionId: 'paper-club', tabKind: 'paper-club.reader', at: { page: '4', h: 'h1' } });
    // What crosses IPC clones: a candidate holding the App's manifest did not (#7521's `app`).
    expect(() => structuredClone(args)).not.toThrow();
    expect(mocks.sessionFilePlace.mock.invocationCallOrder[0]).toBeLessThan(mocks.paneLayoutOpen.mock.invocationCallOrder[0]!);
  });

  it('a place that could not be handed: the click says so with the open-failed toast, and opens nothing half-told', async () => {
    mocks.installedManifests.push({
      id: 'paper-club',
      contributes: { tabs: [{ name: 'reader', title: 'Reader', opensFiles: { session: ['.pdf'] } }] },
    });
    mocks.sessionFilePlace.mockResolvedValue({ success: false, error: 'boom' });

    makeFileLinkHandlers('project-1', 'session-1').onOpenFile('论文/a.pdf', { page: '4' });

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.paneLayoutOpen).not.toHaveBeenCalled();
  });

  it('uses the same active-pane preview chain for task chat and conversation handlers', async () => {
    await openFileInSessionEditor('project-1', 'session-1', 'docs/readme.md');
    makeFileLinkHandlers('project-1', 'session-1').onOpenFile('docs/guide.md');

    await vi.waitFor(() => expect(mocks.activePaneOpen).toHaveBeenCalledTimes(2));
    expect(mocks.fileExists).toHaveBeenNthCalledWith(
      1,
      'project-1',
      'workspace-1',
      '/repo/docs/readme.md'
    );
    expect(mocks.fileExists).toHaveBeenNthCalledWith(
      2,
      'project-1',
      'workspace-1',
      '/repo/docs/guide.md'
    );
    expect(mocks.activePaneOpen).toHaveBeenNthCalledWith(
      1,
      'file',
      { path: '/repo/docs/readme.md' },
      { preview: false }
    );
    expect(mocks.activePaneOpen).toHaveBeenNthCalledWith(
      2,
      'file',
      { path: '/repo/docs/guide.md' },
      { preview: false }
    );
  });

  it('opens a diff header click beside the conversation after the shared validation (spec session-page「并排」)', async () => {
    await openFileBesideConversation('project-1', 'session-1', 'src/index.ts');

    expect(mocks.fileExists).toHaveBeenCalledWith(
      'project-1',
      'workspace-1',
      '/repo/src/index.ts'
    );
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
      'file',
      { path: '/repo/src/index.ts' },
      { preview: false, beside: true }
    );
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
  });

  it('routes outside-workspace Markdown through the same external preview fallback', async () => {
    await openFileInSessionEditor('project-1', 'session-1', '/tmp/Application Support/note.md');
    await openFileBesideConversation('project-1', 'session-1', '/tmp/Application Support/note.md');

    expect(mocks.fileExists).not.toHaveBeenCalled();
    // 工作区外那支是 fire-and-forget(openSessionFile 里 `void openExternalFilePath`),外部 stat
    // 又多了一跳 —— 同步断言会跟第一次 open 赛跑,必须等它落地。
    // 同一条外部预览回退;从对话里点开的那次开在对话旁边(spec session-page「并排」)。
    await vi.waitFor(() => expect(mocks.paneLayoutOpen).toHaveBeenCalledTimes(1));
    expect(mocks.activePaneOpen).toHaveBeenCalledTimes(1);
    expect(mocks.activePaneOpen).toHaveBeenCalledWith(
      'file',
      { path: '/tmp/Application Support/note.md', external: true },
      { preview: false }
    );
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
      'file',
      { path: '/tmp/Application Support/note.md', external: true },
      { preview: false, beside: true }
    );
  });

  it('opens a host-requested preview in the session before acknowledging it', async () => {
    const onResult = vi.fn();
    const dispose = openHostRequestedFileInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      path: '/tmp/Application Support/note.md',
      external: true,
      intent: 'preview',
      onResult,
    });

    // Outside the working copy: read-only external file, no claim consulted, so no opener.
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ success: true, openedWith: null })
    );
    // 开在对话右边并排,❌ 盖住对话(spec gugu-plugin「在工作区打开文件」)。
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
      'file',
      { path: '/tmp/Application Support/note.md', external: true },
      { preview: true, beside: true, activate: false }
    );
    // Outputs 面板记下它,tab 关了还能再开。
    expect(mocks.recordOutput).toHaveBeenCalledWith({
      kind: 'file',
      path: '/tmp/Application Support/note.md',
    });
    dispose();
  });

  it('opens a host-validated page as a browser tab, not as a file path', async () => {
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      url: 'https://www.baidu.com/',
      intent: 'preview',
      onResult,
    });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true }));
    // showPage: the page opens in the browser cell, or the tab already showing it is brought back (workspace-view-model).
    expect(mocks.showPage).toHaveBeenCalledWith('https://www.baidu.com/', { preview: true, reload: true, beside: true, activate: false });
    // The counter-example that lets the assertion above mean something: routing a page
    // through the file branch would still have opened a tab and still reported success.
    expect(mocks.activePaneOpen).not.toHaveBeenCalledWith(
      'file',
      expect.anything(),
      expect.anything()
    );
    expect(mocks.recordOutput).toHaveBeenCalledWith({ kind: 'page', url: 'https://www.baidu.com/' });
    dispose();
  });

  it('#7323 restores the requested existing tab without opening or selecting another page', async () => {
    const original = { browserId: 'original', sessionId: 'session-1', partition: 'persist:original', currentUrl: 'https://qwen.test/chat' };
    const other = { ...original, browserId: 'other', currentUrl: 'https://other.test/' };
    const view = mocks.getSessionPageStore().viewModel;
    view.paneLayout.groups = [{ pane: { resolvedTabs: [
      { kind: 'browser', tabId: 't-other', isActive: true, resource: { browserId: 'other', session: other } },
      { kind: 'browser', tabId: 't-original', isActive: false, resource: { browserId: 'original', session: original } },
    ] } }];
    mocks.registerBrowser.mockResolvedValue({ success: true });
    mocks.ensurePage.mockResolvedValue({ success: true });
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({
      projectId: 'project-1', sessionId: 'session-1', url: 'about:blank', intent: 'pinned',
      acquire: { browserId: 'original', createIfMissing: false, deadline: Date.now() + 9_000 }, onResult,
    });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true, browserId: 'original' }));
    expect(mocks.showPage).not.toHaveBeenCalled();
    expect(mocks.ensurePage).toHaveBeenCalledWith({ browserId: 'original', partition: 'persist:original', url: original.currentUrl });
    expect(mocks.recordOutput).not.toHaveBeenCalled();
    dispose();
  });

  it('#7323 a non-navigation reconnect with no persisted page fails without making a blank tab', async () => {
    mocks.getSessionPageStore().viewModel.paneLayout.groups = [];
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({
      projectId: 'project-1', sessionId: 'session-1', url: 'about:blank', intent: 'pinned',
      acquire: { createIfMissing: false, deadline: Date.now() + 9_000 }, onResult,
    });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('browser_navigate') }));
    expect(mocks.showPage).not.toHaveBeenCalled();
    dispose();
  });

  it('#7323 with no prior binding the focused browser wins over an active tab in another pane', async () => {
    const snapshot = { browserId: 'focused', sessionId: 'session-1', partition: 'persist:focused', currentUrl: 'https://focused.test/' };
    mocks.getSessionPageStore().viewModel.paneLayout.groups = [
      { pane: { resolvedTabs: [{ kind: 'browser', isActive: true, isFocused: false, resource: { browserId: 'other', session: { ...snapshot, browserId: 'other' } } }] } },
      { pane: { resolvedTabs: [{ kind: 'browser', isActive: true, isFocused: true, resource: { browserId: 'focused', session: snapshot } }] } },
    ];
    mocks.registerBrowser.mockResolvedValue({ success: true });
    mocks.ensurePage.mockResolvedValue({ success: true });
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({ projectId: 'project-1', sessionId: 'session-1', url: 'about:blank', intent: 'pinned',
      acquire: { createIfMissing: false, deadline: Date.now() + 9_000 }, onResult });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true, browserId: 'focused' }));
    expect(mocks.showPage).not.toHaveBeenCalled();
    dispose();
  });

  it('#7323 expired acquisition never creates a page, and a failed first navigation rolls back only its new tab', async () => {
    const view = mocks.getSessionPageStore().viewModel;
    const onResult = vi.fn();
    openHostRequestedBrowserInSessionWhenReady({ projectId: 'p', sessionId: 's', url: 'https://a.test/', intent: 'pinned',
      acquire: { createIfMissing: true, deadline: Date.now() - 1 }, onResult });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('timed out') }));
    expect(mocks.showPage).not.toHaveBeenCalled();
    onResult.mockClear();
    const closeTab = vi.fn();
    mocks.showPage.mockImplementation(() => {
      view.paneLayout.groups = [{ pane: { closeTab, resolvedTabs: [{ kind: 'browser', tabId: 'new-tab', resource: {
        browserId: 'new', session: { browserId: 'new', sessionId: 's', partition: 'persist:new', currentUrl: 'https://a.test/' },
      } }] } }];
    });
    mocks.registerBrowser.mockResolvedValue({ success: true });
    mocks.ensurePage.mockResolvedValue({ success: false, error: 'page unavailable' });
    openHostRequestedBrowserInSessionWhenReady({ projectId: 'p', sessionId: 's', url: 'https://a.test/', intent: 'pinned',
      acquire: { createIfMissing: true, deadline: Date.now() + 9_000 }, onResult });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('page unavailable') }));
    expect(closeTab).toHaveBeenCalledExactlyOnceWith('new-tab');
  });

  it('#7323 repeated first navigation acquires one persisted tab rather than stacking duplicates', async () => {
    const view = mocks.getSessionPageStore().viewModel;
    mocks.showPage.mockImplementation(() => {
      view.paneLayout.groups = [{ pane: { resolvedTabs: [{ kind: 'browser', tabId: 'new-tab', resource: {
        browserId: 'new', session: { browserId: 'new', sessionId: 'session-1', partition: 'persist:new', currentUrl: 'https://a.test/' },
      } }] } }];
    });
    mocks.registerBrowser.mockResolvedValue({ success: true });
    mocks.ensurePage.mockResolvedValue({ success: true });
    for (let i = 0; i < 2; i++) {
      const onResult = vi.fn();
      const dispose = openHostRequestedBrowserInSessionWhenReady({ projectId: 'project-1', sessionId: 'session-1', url: 'https://a.test/', intent: 'pinned',
        acquire: { createIfMissing: true, deadline: Date.now() + 9_000 }, onResult });
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true, browserId: 'new' }));
      dispose();
    }
    expect(mocks.showPage).toHaveBeenCalledTimes(1);
    expect(mocks.recordOutput).toHaveBeenCalledExactlyOnceWith({ kind: 'page', url: 'https://a.test/' });
  });

  it('#7323 cancellation during registration removes the new tab and prevents a late page mount', async () => {
    const view = mocks.getSessionPageStore().viewModel;
    const closeTab = vi.fn();
    mocks.showPage.mockImplementation(() => {
      view.paneLayout.groups = [{ pane: { closeTab, resolvedTabs: [{ kind: 'browser', tabId: 'cancelled-tab', resource: {
        browserId: 'cancelled', session: { browserId: 'cancelled', sessionId: 'session-1', partition: 'persist:new', currentUrl: 'https://a.test/' },
      } }] } }];
    });
    let registered!: (result: { success: boolean }) => void;
    mocks.registerBrowser.mockImplementationOnce(() => new Promise((resolve) => { registered = resolve; }));
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({ projectId: 'project-1', sessionId: 'session-1', url: 'https://a.test/', intent: 'pinned',
      acquire: { createIfMissing: true, deadline: Date.now() + 9_000 }, onResult });
    await vi.waitFor(() => expect(registered).toBeDefined());
    dispose();
    expect(closeTab).toHaveBeenCalledWith('cancelled-tab');
    registered({ success: true });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: false, error: expect.stringContaining('aborted') }));
    expect(mocks.ensurePage).not.toHaveBeenCalled();
  });

  /**
   * #6040:renderer 重载后每条会话都回到「没准备」,只有屏上那一条会被 view.tsx 准备。宿主要开的是后台那一条,
   * 光等它的面板就绪是等不来的 —— 等满期限超时。入口自己先请它准备(同一个 provisionSession),准备好了照常打开。
   * 替身里项目一开始没挂上(getSessionManagerStore 为 undefined),所以「先 mountProject 再 provisionSession」也在判据里。
   */
  it('provisions a background session nobody prepared (after a reload), then opens in it', async () => {
    const page = mocks.getSessionPageStore();
    const ready = observable.box<unknown>(undefined);
    mocks.getSessionPageStore.mockImplementation(() => ready.get());
    mocks.provisionSession.mockImplementation(async () => {
      runInAction(() => ready.set(page));
    });
    const onResult = vi.fn();
    const dispose = openHostRequestedBrowserInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-2',
      url: 'https://example.com/',
      intent: 'preview',
      onResult,
      timeout: 1_000,
    });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onResult).toHaveBeenCalledWith({ success: true });
    expect(mocks.mountProject).toHaveBeenCalledWith('project-1');
    expect(mocks.provisionSession).toHaveBeenCalledWith('session-2');
    expect(mocks.showPage).toHaveBeenCalledWith('https://example.com/', { preview: true, reload: true, beside: true, activate: false });
    dispose();
  });

  it('opens an extension tab through the pane layout, which is what takes a runtime kind', async () => {
    mocks.registeredKinds.add('notes.board');
    const onResult = vi.fn();
    const dispose = openHostRequestedExtensionInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      tabKind: 'notes.board',
      intent: 'pinned',
      onResult,
    });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true }));
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('notes.board', {}, { preview: false, beside: true, activate: false });
    // `activePane.open` is typed to built-in kinds, so routing an extension through it
    // could not name this tab at all — that is why this one goes through the layout.
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
    // 扩展 tab 不进 Outputs:它随时能从「+」再开。
    expect(mocks.recordOutput).not.toHaveBeenCalled();
    dispose();
  });

  it('#7317 opens a tab the host brings up on its own only where the task has none; one already there is left alone', async () => {
    mocks.registeredKinds.add('computer-use.preview');
    const open = (onResult: (result: { success: boolean }) => void) =>
      openHostRequestedExtensionInSessionWhenReady({
        projectId: 'project-1',
        sessionId: 'session-1',
        tabKind: 'computer-use.preview',
        intent: 'pinned',
        ifAbsent: true,
        onResult,
      });
    const first = vi.fn();
    const disposeFirst = open(first);
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ success: true }));
    // Beside the conversation, and the tab the person is looking at stays in front.
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('computer-use.preview', {}, { preview: false, beside: true, activate: false });

    mocks.paneLayoutOpen.mockClear();
    mocks.openKinds.push('computer-use.preview');
    const again = vi.fn();
    const disposeAgain = open(again);
    await vi.waitFor(() => expect(again).toHaveBeenCalledWith({ success: true }));
    expect(mocks.paneLayoutOpen).not.toHaveBeenCalled();
    disposeFirst();
    disposeAgain();
  });

  it('registers newly installed extension tabs before opening one', async () => {
    // agent 那条安装路整个发生在主进程里,渲染层压根没听说过这次安装(设置页那条会自己补
    // 登记)。所以「装上、马上打开」必须由这里补一次登记,否则刚装的扩展开不出来。
    mocks.registerInstalledExtensionTabs.mockImplementation(() => {
      mocks.registeredKinds.add('fresh.panel');
      return Promise.resolve();
    });
    const onResult = vi.fn();
    const dispose = openHostRequestedExtensionInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      tabKind: 'fresh.panel',
      intent: 'pinned',
      onResult,
    });

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: true }));
    expect(mocks.registerInstalledExtensionTabs).toHaveBeenCalledTimes(1);
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('fresh.panel', {}, { preview: false, beside: true, activate: false });
    dispose();
  });

  it('reports a tab kind this window does not know as not opened, not as done', async () => {
    // `paneLayout.open` 对不认识的 kind 只 console.warn 就返回,不抛 —— 照原样往下走,宿主
    // 会收到「开好了」而屏幕上什么都没有。这条钉住的就是那个假绿。
    const onResult = vi.fn();
    const dispose = openHostRequestedExtensionInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      tabKind: 'never-installed.panel',
      intent: 'pinned',
      onResult,
    });

    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('never-installed.panel'),
      })
    );
    expect(mocks.paneLayoutOpen).not.toHaveBeenCalled();
    dispose();
  });

  it('sends an agent-requested file through the same resolver a click uses', async () => {
    mocks.installedManifests.push({
      id: 'sheets',
      contributes: { tabs: [{ name: 'grid', title: 'Grid', opensFiles: { session: ['.csv'] } }] },
    });
    const onResult = vi.fn();
    const dispose = openHostRequestedFileInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      path: '/repo/session-1/data/report.csv',
      external: false,
      intent: 'preview',
      onResult,
    });

    // The claiming tab took it, opened ON the file, and the ack says so — the host
    // reports that outcome rather than predicting it.
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ success: true, openedWith: 'sheets.grid' })
    );
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
      'sheets.grid',
      { filePath: '/repo/session-1/data/report.csv' },
      { preview: true, beside: true, activate: false }
    );
    // The counter-example: the built-in editor must not also have opened it.
    expect(mocks.activePaneOpen).not.toHaveBeenCalled();
    dispose();
  });

  describe('「用哪个打开」 when several Apps claim it (真源 §2.4, 主人 09-29)', () => {
    const twoClaims = () => {
      mocks.installedManifests.push(
        { id: 'sheets', contributes: { tabs: [{ name: 'grid', title: 'Grid', opensFiles: { session: ['.csv'] } }] } },
        { id: 'tables', contributes: { tabs: [{ name: 'main', title: 'Tables', opensFiles: { session: ['.csv'] } }] } },
      );
    };

    it('asks, and opens the one picked', async () => {
      twoClaims();
      // Not awaited yet: opening the file waits for the person's pick.
      const opening = openFileInSessionEditor('project-1', 'session-1', 'data/report.csv');
      await vi.waitFor(() => expect(mocks.showModal).toHaveBeenCalledTimes(1));
      const [id, args] = mocks.showModal.mock.calls[0]!;
      expect(id).toBe('openWithChooserModal');
      expect(args.candidates.map((c: { tabKind: string }) => c.tabKind)).toEqual(['sheets.grid', 'tables.main']);
      // Control: nothing opened before the person picked.
      expect(mocks.paneLayoutOpen).not.toHaveBeenCalled();
      args.onSuccess({ tabKind: 'tables.main', always: false });
      await opening;
      expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('tables.main', { filePath: '/repo/data/report.csv' }, { preview: false });
      expect(mocks.activePaneOpen).not.toHaveBeenCalled();
    });

    it('cancelled: nothing opens, and an agent-requested open says nobody was picked', async () => {
      twoClaims();
      const onResult = vi.fn();
      const dispose = openHostRequestedFileInSessionWhenReady({
        projectId: 'project-1', sessionId: 'session-1', path: '/repo/session-1/data/report.csv', external: false, intent: 'preview', onResult,
      });
      await vi.waitFor(() => expect(mocks.showModal).toHaveBeenCalledTimes(1));
      mocks.showModal.mock.calls[0]![1].onClose();
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith({ success: false, error: 'The person did not pick an App to open it with' }));
      expect(mocks.paneLayoutOpen).not.toHaveBeenCalled();
      expect(mocks.activePaneOpen).not.toHaveBeenCalled();
      dispose();
    });

    it('a remembered 「始终用它」 opens straight away — the built-in editor included', async () => {
      twoClaims();
      mocks.openWithDefaults = { 'session:.csv': 'tables.main' };
      await openFileInSessionEditor('project-1', 'session-1', 'data/report.csv');
      await vi.waitFor(() => expect(mocks.paneLayoutOpen).toHaveBeenCalledWith('tables.main', { filePath: '/repo/data/report.csv' }, { preview: false }));
      mocks.openWithDefaults = { 'session:.csv': 'builtin' };
      await openFileInSessionEditor('project-1', 'session-1', 'data/other.csv');
      await vi.waitFor(() => expect(mocks.activePaneOpen).toHaveBeenCalled());
      expect(mocks.showModal).not.toHaveBeenCalled();
    });
  });

  it('reports openedWith null when no extension claimed the type', async () => {
    const onResult = vi.fn();
    const dispose = openHostRequestedFileInSessionWhenReady({
      projectId: 'project-1',
      sessionId: 'session-1',
      path: '/repo/session-1/src/index.ts',
      external: false,
      intent: 'preview',
      onResult,
    });

    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ success: true, openedWith: null })
    );
    expect(mocks.paneLayoutOpen).toHaveBeenCalledWith(
      'file',
      { path: '/repo/session-1/src/index.ts' },
      { preview: true, beside: true, activate: false }
    );
    dispose();
  });
});
