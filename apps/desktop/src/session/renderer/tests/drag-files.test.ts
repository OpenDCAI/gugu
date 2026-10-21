import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDraggedWorkspaceFile,
  droppedDirectoryMention,
  getDraggedWorkspaceFile,
  hasDraggedWorkspaceFile,
  setDraggedWorkspaceFile,
} from '@renderer/lib/drag-files';

function makeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    types: [] as string[],
    files: [] as unknown as FileList,
    effectAllowed: 'all',
    setData(type: string, value: string) {
      if (!values.has(type)) this.types.push(type);
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
  };
  return transfer as unknown as DataTransfer;
}

describe('drag-files', () => {
  it('carries workspace file payloads for same-window drops', () => {
    const dataTransfer = makeDataTransfer();

    setDraggedWorkspaceFile(dataTransfer, {
      workspaceId: 'workspace-1',
      targetPath: '/remote/repo/src/index.ts',
      targetPlatform: 'linux',
    });

    expect(hasDraggedWorkspaceFile(dataTransfer)).toBe(true);
    expect(getDraggedWorkspaceFile(dataTransfer)).toEqual({
      workspaceId: 'workspace-1',
      targetPath: '/remote/repo/src/index.ts',
      targetPlatform: 'linux',
    });
    expect(dataTransfer.getData('text/plain')).toBe('/remote/repo/src/index.ts');
  });

  it('does not accept stale workspace state without a matching transfer marker', () => {
    const sourceTransfer = makeDataTransfer();
    setDraggedWorkspaceFile(sourceTransfer, {
      workspaceId: 'workspace-1',
      targetPath: '/repo/src/index.ts',
    });

    const unrelatedTransfer = makeDataTransfer();

    expect(hasDraggedWorkspaceFile(unrelatedTransfer)).toBe(false);
    expect(getDraggedWorkspaceFile(unrelatedTransfer)).toBeNull();
    clearDraggedWorkspaceFile();
  });

  it('falls back to the serialized transfer payload after dragend clears same-window state', () => {
    const dataTransfer = makeDataTransfer();
    setDraggedWorkspaceFile(dataTransfer, {
      workspaceId: 'workspace-1',
      targetPath: '/repo/src/index.ts',
    });
    clearDraggedWorkspaceFile();

    expect(getDraggedWorkspaceFile(dataTransfer)).toEqual({
      workspaceId: 'workspace-1',
      targetPath: '/repo/src/index.ts',
    });
  });
});

describe('droppedDirectoryMention', () => {
  // node 环境没有 preload 注入 —— 直接往桥上放一个只实现 getPathForFile 的假桥。
  function stubHostBridge(pathForFile: (file: File) => string) {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { getPathForFile: pathForFile },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  function fakeFolderFile(name: string): File {
    return { name, size: 0, type: '' } as unknown as File;
  }

  it('带本地路径的文件夹 → 一枚 file 提及,显示名是末级目录名', () => {
    stubHostBridge(() => '/Users/owner/Assets/截图存档');
    const mention = droppedDirectoryMention(fakeFolderFile('截图存档'));
    expect(mention).toEqual({
      id: '/Users/owner/Assets/截图存档',
      label: '/Users/owner/Assets/截图存档',
      kind: 'file',
      name: '截图存档',
    });
  });

  it('Windows 路径同样取末级目录名', () => {
    stubHostBridge(() => 'C:\\Users\\owner\\Assets');
    const mention = droppedDirectoryMention(fakeFolderFile('Assets'));
    expect(mention?.name).toBe('Assets');
    expect(mention?.label).toBe('C:\\Users\\owner\\Assets');
  });

  it('取不出路径(空串)→ null,❌ 造一枚指向空的提及', () => {
    stubHostBridge(() => '  ');
    expect(droppedDirectoryMention(fakeFolderFile('dir'))).toBeNull();
  });
});
