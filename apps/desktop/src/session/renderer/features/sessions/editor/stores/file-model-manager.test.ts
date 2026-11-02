import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInAction } from 'mobx';

// async:observable 要在 vi.mock 工厂之前就有,而 vi.hoisted 跑在所有 import 之前。
const mocks = await vi.hoisted(async () => {
  const { observable } = await import('mobx');
  return {
    readFile: vi.fn(),
    readExternalFile: vi.fn(),
    readImage: vi.fn(),
    registerModel: vi.fn(),
    modelStatus: new Map<string, string>(),
    modelTotalSizes: new Map<string, number>(),
    unregisterModel: vi.fn(),
    clearBuffer: vi.fn(),
    watchDirectory: vi.fn(async () => ({ success: true, data: { leaseId: 'lease-1' } })),
    releaseDirectoryWatch: vi.fn(async () => undefined),
    diskVersions: observable.map<string, number>(),
  };
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspace: {
      files: {
        readFile: mocks.readFile,
        readExternalFile: mocks.readExternalFile,
        readImage: mocks.readImage,
        watchDirectory: mocks.watchDirectory,
        releaseDirectoryWatch: mocks.releaseDirectoryWatch,
      },
      editor: { clearBuffer: mocks.clearBuffer },
    },
  },
}));

vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({
  modelRegistry: {
    modelStatus: mocks.modelStatus,
    modelTotalSizes: mocks.modelTotalSizes,
    registerModel: mocks.registerModel,
    unregisterModel: mocks.unregisterModel,
    toDiskUri: (uri: string) => uri.replace(/^file:\/\//, 'disk://'),
    diskVersion: (workspaceId: string, path: string) => mocks.diskVersions.get(`${workspaceId}:${path}`) ?? 0,
  },
}));

vi.mock('@renderer/utils/diffUtils', () => ({
  getMonacoLanguageId: vi.fn(() => 'xml'),
}));

import { FileModelManager } from './file-model-manager';

/** acquire 之后模型是异步注册的:第 n 次注册那一刻 resolve(每次都回 uri)。 */
function registeredTimes(n: number, uri: string): Promise<void> {
  const done = Promise.withResolvers<void>();
  mocks.registerModel.mockImplementation(async () => {
    if (mocks.registerModel.mock.calls.length === n) done.resolve();
    return uri;
  });
  return done.promise;
}

describe('FileModelManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modelStatus.clear();
    mocks.modelTotalSizes.clear();
    mocks.diskVersions.clear();
  });

  it('loads SVG source through Monaco so the preview has buffer content', async () => {
    mocks.readFile.mockResolvedValue({
      success: true,
      data: {
        content: '<svg xmlns="http://www.w3.org/2000/svg"><title>ok</title></svg>',
        binary: false,
        truncated: false,
        totalSize: 65,
      },
    });
    mocks.readImage.mockResolvedValue({
      success: true,
      data: { success: true, dataUrl: 'data:image/svg+xml;base64,ignored' },
    });
    const registered = registeredTimes(2, 'file://root/art.svg');

    const resource = {
      setImageContent: vi.fn(),
      setContentType: vi.fn(),
      setTotalSize: vi.fn(),
    };
    const manager = new FileModelManager({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      modelRootPath: '/workspace',
    });

    manager.acquire('art.svg', resource as never);

    await registered;
    expect(mocks.registerModel).toHaveBeenCalledTimes(2);
    expect(mocks.readImage).not.toHaveBeenCalled();
    expect(mocks.registerModel.mock.calls.map(([, , , , , type]) => type)).toEqual([
      'disk',
      'buffer',
    ]);
    expect(resource.setImageContent).not.toHaveBeenCalled();
  });

  // 图片读一次字节就画:盘上这个文件变了(diskVersion 动了)要重读,❌ 停在旧图上直到关掉页签重开。
  it('re-reads an image when the file changes on disk', async () => {
    let n = 0;
    const read = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    mocks.readImage.mockImplementation(async () => {
      n += 1;
      read[n - 1]?.resolve();
      return { success: true, data: { success: true, dataUrl: `data:image/png;base64,V${n}` } };
    });
    const resource = { setImageContent: vi.fn(), setContentType: vi.fn(), setTotalSize: vi.fn() };
    const manager = new FileModelManager({ projectId: 'project-1', workspaceId: 'workspace-1', modelRootPath: '/workspace' });

    manager.acquire('/workspace/pic.png', resource as never);
    await read[0].promise;
    runInAction(() => mocks.diskVersions.set('workspace-1:/workspace/pic.png', 1));
    await read[1].promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.readImage).toHaveBeenCalledTimes(2);
    expect(resource.setImageContent).toHaveBeenLastCalledWith('data:image/png;base64,V2');
    manager.release('/workspace/pic.png', resource as never);
    runInAction(() => mocks.diskVersions.set('workspace-1:/workspace/pic.png', 2));
    expect(mocks.readImage).toHaveBeenCalledTimes(2);
  });

  // @@@tree-by-directories:一个目录一个 watch 的平台上,工作区的变化流只看被报过的目录 —— 打开文件就报它所在的目录,
  // 最后一个页签关掉就撤;工作区之外的文件不属于任何变化流,不报。
  it('tells the machine which directory an open file is in, and takes it back when the last tab closes', async () => {
    mocks.readImage.mockResolvedValue({ success: true, data: { success: true, dataUrl: 'data:image/png;base64,A' } });
    const manager = new FileModelManager({ projectId: 'project-1', workspaceId: 'workspace-1', modelRootPath: '/workspace' });
    const a = { setImageContent: vi.fn(), setContentType: vi.fn(), setTotalSize: vi.fn(), isExternal: false };
    const b = { ...a };

    manager.acquire('/workspace/img/pic.png', a as never);
    manager.acquire('/workspace/img/pic.png', b as never);
    manager.acquire('/Users/me/outside.png', { ...a, isExternal: true } as never);
    expect(mocks.watchDirectory.mock.calls).toEqual([['project-1', 'workspace-1', '/workspace/img']]);

    manager.release('/workspace/img/pic.png', a as never);
    await Promise.resolve();
    expect(mocks.releaseDirectoryWatch).not.toHaveBeenCalled();
    manager.release('/workspace/img/pic.png', b as never);
    await new Promise((r) => setTimeout(r, 0)); // 租约是异步拿到的:让那两跳微任务走完
    expect(mocks.releaseDirectoryWatch).toHaveBeenCalledWith('project-1', 'workspace-1', 'lease-1');
  });

  it('reads a file outside the workspace through readExternalFile, under its own root', async () => {
    mocks.readExternalFile.mockResolvedValue({
      success: true,
      data: { content: '<h1>hi</h1>', binary: false, truncated: false, totalSize: 11 },
    });
    const registered = registeredTimes(2, 'file://external:/Users/me/plan.html');

    const manager = new FileModelManager({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      modelRootPath: 'workspace:workspace-1',
    });

    manager.acquire('/Users/me/plan.html', { isExternal: true } as never);

    await registered;
    expect(mocks.registerModel).toHaveBeenCalledTimes(2);
    expect(mocks.registerModel.mock.calls.map(([, , , , , type]) => type)).toEqual([
      'disk',
      'buffer',
    ]);
    expect(mocks.registerModel.mock.calls.every(([, , root]) => root === 'external:')).toBe(true);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('keeps a workspace file on the workspace root', async () => {
    mocks.readFile.mockResolvedValue({
      success: true,
      data: { content: 'a,b', binary: false, truncated: false, totalSize: 3 },
    });
    const registered = registeredTimes(2, 'file://workspace:workspace-1/data.csv');

    const manager = new FileModelManager({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      modelRootPath: 'workspace:workspace-1',
    });

    manager.acquire('data.csv', { isExternal: false } as never);

    await registered;
    expect(mocks.registerModel).toHaveBeenCalledTimes(2);
    expect(mocks.registerModel.mock.calls.map(([, , root]) => root)).toEqual([
      'workspace:workspace-1',
      'workspace:workspace-1',
    ]);
  });

  // 文件页签不读 git 那一侧:非 git 工作区的 git 读取只会失败,不能挡住正文。
  it('registers no git model, so a workspace without git still shows the file', async () => {
    const registered = registeredTimes(2, 'file://workspace:workspace-1/notes.txt');
    const manager = new FileModelManager({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      modelRootPath: 'workspace:workspace-1',
    });

    manager.acquire('notes.txt', { isExternal: false } as never);

    await registered;
    expect(mocks.registerModel.mock.calls.map(([, , , , , type]) => type)).toEqual(['disk', 'buffer']);
    manager.dispose();
    expect(mocks.unregisterModel.mock.calls.flat().some((uri) => String(uri).startsWith('git://'))).toBe(false);
  });
});
