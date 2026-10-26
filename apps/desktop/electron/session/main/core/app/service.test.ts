import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { ContentMenuEntry } from '../../../../content-context-menu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getVersion: vi.fn(() => '1.1.27'),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showMenu: vi.fn<(items: ContentMenuEntry[], position: unknown) => void>(),
  eventEmit: vi.fn(),
  // @@@electron44-clipboard (#4394) — 必须 resolve 一个 Promise:electron 44 起 clipboard.writeText
  // 是异步的,产品码会 await / .catch 它。mock 返回 undefined 就是拿旧同步 API 的口径当真值,
  // 会把「产品码正确处理了异步」判成失败。
  clipboardWriteText: vi.fn(async () => {}),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => ''),
    getVersion: mocks.getVersion,
    quit: vi.fn(),
  },
  clipboard: {
    writeText: mocks.clipboardWriteText,
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openExternal: mocks.openExternal,
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder,
  },
}));

vi.mock('../../../../content-context-menu', () => ({ showContentContextMenu: mocks.showMenu }));

vi.mock('@main/app/window', () => ({
  getMainWindow: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('@main/db/schema', () => ({
  sshConnections: {},
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: mocks.eventEmit,
    on: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/childProcessEnv', () => ({
  buildExternalToolEnv: () => ({}),
}));

const { appService } = await import('./service');

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatform,
    value: platform,
  });
}

describe('AppService.openIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('win32');
    mocks.openPath.mockResolvedValue('');
    mocks.exec.mockImplementation(
      (_command: string, _options: object, callback: (error: Error | null) => void) => {
        callback(null);
      }
    );
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  /**
   * ⚠️ 这三条走**真**文件系统,不 mock `stat` —— 分支判据就是「这个路径到底是不是目录」,
   * 把它 mock 掉等于把被测的那句话换成常量。`node:fs/promises` 本文件也确实没 mock。
   */
  async function makeTempDir(): Promise<string> {
    return mkdtemp(join(await realpath(tmpdir()), 'gugu-openin-'));
  }

  it('目录 → shell.openPath 打开它本身,不走 shell 命令', async () => {
    const dir = await makeTempDir();
    try {
      await appService.openIn({ app: 'finder', path: dir });

      expect(mocks.openPath).toHaveBeenCalledWith(dir);
      expect(mocks.showItemInFolder).not.toHaveBeenCalled();
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('文件 → 在所在目录里选中它,❌ 不用系统默认程序打开', async () => {
    // 这条是回归守卫。`shell.openPath(文件)` 的语义是「用系统默认程序打开这个文件」——
    // owner 实机点「用 Finder 打开」,macOS 按 .json 的默认程序把 Cursor 拉起来了。
    // 文件面板开始把**文件**路径传进来之后才暴露;以前只喂目录,所以一直看着是对的。
    const dir = await makeTempDir();
    const file = join(dir, 'notes.json');
    try {
      await writeFile(file, '{}');

      await appService.openIn({ app: 'finder', path: file });

      expect(mocks.showItemInFolder).toHaveBeenCalledWith(file);
      expect(mocks.openPath).not.toHaveBeenCalled();
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('目录打不开时响亮报错,不吞掉 Electron 给的原因', async () => {
    const dir = await makeTempDir();
    try {
      mocks.openPath.mockResolvedValueOnce('Path does not exist');

      await expect(appService.openIn({ app: 'finder', path: dir })).rejects.toThrow(
        'Path does not exist'
      );
      expect(mocks.openPath).toHaveBeenCalledWith(dir);
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AppService.showItemInFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reveals the resolved path with Electron shell.showItemInFolder', async () => {
    await appService.showItemInFolder(homedir());

    expect(mocks.showItemInFolder).toHaveBeenCalledWith(await realpath(homedir()));
  });

  it('rejects paths outside the user home directory', async () => {
    await expect(appService.showItemInFolder(tmpdir())).rejects.toThrow(
      'Path must be inside the user home directory'
    );
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });
});

/**
 * #7191 PR 审查:「用系统默认程序打开」/「用 Office 软件打开」走 openPath,而它只认 home ——
 * 外接盘、/opt 上的工作区里的文件,给出的下一步永远打不开。系统临时目录在 home 外(上面 showItemInFolder
 * 那条已经这么用),拿它当一个 home 外的工作区。真文件系统,不 mock realpath。
 */
describe('AppService.openPath 与工作区', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openPath.mockResolvedValue('');
  });

  async function outsideHomeWorkspace(): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-openpath-ws-'));
    const file = join(root, '报表.xlsx');
    await writeFile(file, 'x');
    return { root, file };
  }

  it('home 外的工作区:说出工作区就能打开它里面的文件', async () => {
    const { root, file } = await outsideHomeWorkspace();
    try {
      await appService.openPath(file, root);
      expect(mocks.openPath).toHaveBeenCalledWith(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('不说工作区:照旧只认 home', async () => {
    const { root, file } = await outsideHomeWorkspace();
    try {
      await expect(appService.openPath(file)).rejects.toThrow('Path must be inside the user home directory');
      expect(mocks.openPath).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('说了工作区,但文件在它外面(也在 home 外):拒绝', async () => {
    const a = await outsideHomeWorkspace();
    const b = await outsideHomeWorkspace();
    try {
      await expect(appService.openPath(b.file, a.root)).rejects.toThrow('Path must be inside the user home directory');
      expect(mocks.openPath).not.toHaveBeenCalled();
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(b.root, { recursive: true, force: true });
    }
  });
});

describe('AppService.showTerminalContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies the exact selected terminal text without trimming whitespace', () => {
    appService.showTerminalContextMenu({
      requestId: 'request-1',
      selectionText: '  indented value\n',
      x: 10,
      y: 20,
    });

    const template = mocks.showMenu.mock.calls[0]?.[0];
    const copyItem = template?.find((item) => item.type !== 'separator' && item.label === 'Copy');

    expect((copyItem?.type !== 'separator' && copyItem?.enabled)).toBe(true);
    copyItem?.click?.();

    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('  indented value\n');
  });

  it('preserves link copying, terminal actions and host menu coordinates', () => {
    appService.showTerminalContextMenu({ requestId: 'terminal', selectionText: '', linkText: ' https://example.com/ ', x: 10.2, y: 20.8 });
    const template = mocks.showMenu.mock.calls[0]![0];
    expect(template.map(item => item.type === 'separator' ? item.type : item.label)).toEqual(['Copy', 'Copy Link', 'Paste', 'separator', 'Select All', 'Clear']);
    expect((template[0]!.type !== 'separator' && template[0]!.enabled)).toBe(false);
    template[1]!.click?.();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('https://example.com/');
    for (const index of [2, 4, 5]) template[index]!.click?.();
    expect(mocks.eventEmit.mock.calls.map(call => call[1])).toEqual([
      { requestId: 'terminal', action: 'paste' }, { requestId: 'terminal', action: 'select-all' }, { requestId: 'terminal', action: 'clear' },
    ]);
    expect(mocks.showMenu.mock.calls[0]![1]).toEqual({ window: undefined, x: 10, y: 21 });
  });
});
