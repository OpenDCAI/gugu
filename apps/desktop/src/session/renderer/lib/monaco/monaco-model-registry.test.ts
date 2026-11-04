import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAD_REF, STAGED_REF } from '@shared/core/git/types';
import {
  EDITOR_CONFIRM_FILE_BYTES,
  EDITOR_HARD_MAX_FILE_BYTES,
} from '@renderer/lib/editor/file-size-limits';
import { MonacoModelRegistry } from './monaco-model-registry';
import { buildMonacoModelPath, EXTERNAL_MODEL_ROOT } from './monacoModelPath';

const rpcState = vi.hoisted(() => ({
  indexContent: 'base' as string | null,
  refContent: 'base' as string | null,
  indexError: null as string | null,
  refError: null as string | null,
}));

const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => ({
    success: true,
    data: { content: 'in the workspace', binary: false, truncated: false, totalSize: 16 },
  })),
  readExternalFile: vi.fn(async () => ({
    success: true,
    data: { content: '<h1>outside</h1>', binary: false, truncated: false, totalSize: 16 },
  })),
  writeFile: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ success: true, data: { success: true, bytesWritten: 1 } })),
  fileExists: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ success: true, data: { exists: true, isDirectory: false } })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspace: {
      gitWorktree: {
        getFileAtIndex: vi.fn(async () => rpcState.indexError ? ({ success: false, error: { type: 'git_error', message: rpcState.indexError } }) : ({
          success: true,
          data: { content: rpcState.indexContent },
        })),
        getFileAtRef: vi.fn(async () => rpcState.refError ? ({ success: false, error: { type: 'git_error', message: rpcState.refError } }) : ({
          success: true,
          data: { content: rpcState.refContent },
        })),
      },
      fs: {
        readFile: vi.fn(async () => ({
          success: true,
          data: { content: 'base', truncated: false, totalSize: 4 },
        })),
      },
      files: {
        readFile: fileMocks.readFile,
        readExternalFile: fileMocks.readExternalFile,
        writeFile: fileMocks.writeFile,
        fileExists: fileMocks.fileExists,
      },
      editor: {
        saveBuffer: vi.fn(),
        clearBuffer: vi.fn(),
      },
    },
  },
}));

class FakeModel {
  private value: string;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(
    value: string,
    readonly uri: { toString(): string; scheme: string }
  ) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  /** 1 起的行列 → 偏移(与 Monaco 同一套坐标)。 */
  private offsetAt(line: number, column: number): number {
    const lines = this.value.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1; i += 1) offset += (lines[i]?.length ?? 0) + 1;
    return offset + column - 1;
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.value.slice(0, offset).split('\n');
    return { lineNumber: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 };
  }

  /** Every edit in the model's coordinates before any of them, as Monaco takes them. */
  applyEdits(
    edits: Array<{ text: string; range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } }>
  ): void {
    const edit = edits[0];
    if (!edit) return;
    if (!edit.range || edit.range.startLineNumber === undefined) {
      this.setValue(edit.text);
      return;
    }
    const spans = edits
      .map(({ range, text }) => ({ start: this.offsetAt(range!.startLineNumber, range!.startColumn), end: this.offsetAt(range!.endLineNumber, range!.endColumn), text }))
      .sort((a, b) => b.start - a.start);
    let value = this.value;
    for (const span of spans) value = value.slice(0, span.start) + span.text + value.slice(span.end);
    this.setValue(value);
  }

  getFullModelRange(): unknown {
    return {};
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function makeFakeMonaco() {
  const models = new Map<string, FakeModel>();
  return {
    Uri: {
      parse(value: string) {
        return {
          scheme: value.split(':')[0] ?? '',
          toString: () => value,
        };
      },
    },
    editor: {
      getModel(uri: { toString(): string }) {
        return models.get(uri.toString()) ?? null;
      },
      createModel(content: string, _language: string, uri: { toString(): string; scheme: string }) {
        const model = new FakeModel(content, uri);
        models.set(uri.toString(), model);
        return model;
      },
    },
  };
}

describe('MonacoModelRegistry', () => {
  beforeEach(() => {
    rpcState.indexContent = 'base';
    rpcState.refContent = 'base';
    rpcState.indexError = null;
    rpcState.refError = null;
    fileMocks.readFile.mockClear();
    fileMocks.readExternalFile.mockClear();
  });

  // #5903:文件监听喂进来的是原生分隔符的绝对路径(Windows 上是 `\`),而模型的 filePath 是
  // 打开它的那条路给的拼法(聊天里的文件链接带来的是 `/`)。这一处比较是「这条变更是不是这个
  // 模型的文件」的唯一判定,拼法不归一就永远 hit=0,改了盘上的文件、面板一直是旧的。
  it('把同一个文件的两种分隔符拼法认作同一个文件(否则盘上的变更永远 invalidate 不到)', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    // 从聊天链接打开 —— 带来的是正斜杠拼法
    await registry.registerModel(
      'project',
      'workspace',
      EXTERNAL_MODEL_ROOT,
      'D:/gw/task-home/咕咕 Beta/pelican.svg',
      'xml',
      'disk'
    );

    // 文件监听报的是原生分隔符那份:必须命中同一个模型
    expect(
      registry.findDiskUris({
        workspaceId: 'workspace',
        filePath: 'D:\\gw\\task-home\\咕咕 Beta\\pelican.svg',
      })
    ).toHaveLength(1);

    // 反向控:**另一个**文件不能因为归一化被误判成同一个
    expect(
      registry.findDiskUris({
        workspaceId: 'workspace',
        filePath: 'D:\\gw\\task-home\\咕咕 Beta\\other.svg',
      })
    ).toHaveLength(0);

    // 反向控:工作区不同就不该命中
    expect(
      registry.findDiskUris({
        workspaceId: 'another-workspace',
        filePath: 'D:/gw/task-home/咕咕 Beta/pelican.svg',
      })
    ).toHaveLength(0);
  });

  it('reads a file outside the workspace through readExternalFile and serves it as text', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const uri = await registry.registerModel(
      'project',
      'workspace',
      EXTERNAL_MODEL_ROOT,
      '/Users/me/plan.html',
      'html',
      'disk'
    );
    const diskUri = registry.toDiskUri(uri);

    expect(fileMocks.readExternalFile).toHaveBeenCalledWith(
      'project',
      'workspace',
      '/Users/me/plan.html',
      EDITOR_CONFIRM_FILE_BYTES
    );
    expect(fileMocks.readFile).not.toHaveBeenCalled();
    expect(registry.modelStatus.get(diskUri)).toBe('ready');
    expect(registry.getText(diskUri)).toBe('<h1>outside</h1>');
    // The trap #5585 was made of: getValue answers for buffers only, so a preview that
    // asks it about a read-only disk model gets null and draws「Empty file」.
    expect(registry.getValue(diskUri)).toBeNull();
  });

  // #5750 的判据:一个 493.7 KB 的 HTML(owner 真机上那个文件的大小)必须照常打开。
  // 旧代码这条读取不传上限,落到 `IFileSystem` 给 SSH 远程读盘设的 200 KB 默认值,
  // 于是 truncated=true、状态标成 too-large —— 源码和 HTML 预览一起没了。
  it('opens a half-megabyte file instead of calling it too large', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const totalSize = 505_582;
    const content = 'x'.repeat(totalSize);
    // 按编辑器传下来的上限决定给正文还是给 too-large —— 与真实 FS 同一条约定:
    // 超限就不读,只回大小。
    fileMocks.readFile.mockImplementationOnce(async (..._args: unknown[]) => {
      const maxBytes = _args[3] as number | undefined;
      const overLimit = maxBytes === undefined || totalSize > maxBytes;
      return {
        success: true,
        data: {
          content: overLimit ? '' : content,
          binary: false,
          truncated: overLimit,
          totalSize,
        },
      };
    });

    const uri = await registry.registerModel(
      'project',
      'workspace',
      '/ws',
      'report.html',
      'html',
      'disk'
    );
    const diskUri = registry.toDiskUri(uri);

    expect(fileMocks.readFile).toHaveBeenCalledWith(
      'project',
      'workspace',
      'report.html',
      EDITOR_CONFIRM_FILE_BYTES
    );
    expect(registry.modelStatus.get(diskUri)).toBe('ready');
    expect(registry.getText(diskUri)).toHaveLength(totalSize);
  });

  // 同一个默认值造成的丢数据:文件在外部被写大之后重读,半截正文覆盖缓冲区,
  // 用户下一次保存就把 cut 之后的内容写没了。
  it('refuses to overwrite the buffer with a truncated re-read', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const uri = await registry.registerModel(
      'project',
      'workspace',
      '/ws',
      'notes.md',
      'markdown',
      'disk'
    );
    const diskUri = registry.toDiskUri(uri);
    expect(registry.getText(diskUri)).toBe('in the workspace');

    fileMocks.readFile.mockImplementationOnce(async () => ({
      success: true,
      data: { content: '', binary: false, truncated: true, totalSize: 40_000_000 },
    }));
    await registry.invalidateModel(diskUri);

    expect(registry.modelStatus.get(diskUri)).toBe('too-large');
    expect(registry.modelTotalSizes.get(diskUri)).toBe(40_000_000);
    // ❌ 原文没有被那半截内容盖掉。
    expect(registry.getText(diskUri)).toBe('in the workspace');
  });

  // #5763 的判据:体积上限是「默认不替你打开」,不是一堵墙。同一个文件按确认门槛读被拒,
  // 按硬顶再读一次就该真的读进来 —— 第二次**不许**被 dedup 缓存喂回第一次那个「太大」。
  it('re-reads the same file when asked for a bigger limit', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const totalSize = 26_214_525;
    const content = 'x'.repeat(1000);
    // 用 Once 排队,❌ 不装持久实现 —— 那会漏给后面的用例,而 beforeEach 只做 mockClear。
    const byLimit = async (..._args: unknown[]) => {
      const maxBytes = _args[3] as number;
      const overLimit = totalSize > maxBytes;
      return {
        success: true,
        data: { content: overLimit ? '' : content, binary: false, truncated: overLimit, totalSize },
      };
    };
    fileMocks.readFile.mockImplementationOnce(byLimit).mockImplementationOnce(byLimit);

    const uri = await registry.registerModel(
      'project', 'workspace', '/ws', 'huge.html', 'html', 'disk'
    );
    const diskUri = registry.toDiskUri(uri);
    expect(fileMocks.readFile).toHaveBeenLastCalledWith(
      'project', 'workspace', 'huge.html', EDITOR_CONFIRM_FILE_BYTES
    );
    expect(registry.modelStatus.get(diskUri)).toBe('too-large');
    expect(registry.modelTotalSizes.get(diskUri)).toBe(totalSize);

    // 「仍然打开」:同一条注册路径,只是把这一次的上限抬到硬顶。
    await registry.registerModel(
      'project', 'workspace', '/ws', 'huge.html', 'html', 'disk', undefined,
      EDITOR_HARD_MAX_FILE_BYTES
    );
    expect(fileMocks.readFile).toHaveBeenLastCalledWith(
      'project', 'workspace', 'huge.html', EDITOR_HARD_MAX_FILE_BYTES
    );
    expect(registry.modelStatus.get(diskUri)).toBe('ready');
    expect(registry.getText(diskUri)).toHaveLength(1000);
  });

  it.each([STAGED_REF, HEAD_REF])('shows a read error rather than an empty diff for %j', async ref => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    const uri = buildMonacoModelPath('workspace:workspace', 'file.ts');
    if (ref.kind === 'staged') rpcState.indexError = 'permission denied';
    else rpcState.refError = 'transport failed';
    await expect(registry.registerModel('project', 'workspace', 'workspace:workspace', 'file.ts', 'typescript', 'git', ref)).rejects.toThrow();
    expect(registry.modelStatus.get(registry.toGitUri(uri, ref))).toBe('error');
    expect(registry.getModelByUri(registry.toGitUri(uri, ref))).toBeUndefined();
  });

  it('keeps a failed git refresh in error state and recovers on the next successful refresh', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    const uri = await registry.registerModel('project', 'workspace', 'workspace:workspace', 'file.ts', 'typescript', 'git', HEAD_REF);
    const gitUri = registry.toGitUri(uri, HEAD_REF);
    rpcState.refError = 'connection failed';
    await expect(registry.invalidateModel(gitUri)).rejects.toThrow();
    expect(registry.modelStatus.get(gitUri)).toBe('error');
    expect(registry.getModelByUri(gitUri)?.getValue()).toBe('base');
    rpcState.refError = null;
    rpcState.refContent = null;
    await registry.invalidateModel(gitUri);
    expect(registry.modelStatus.get(gitUri)).toBe('ready');
    expect(registry.getModelByUri(gitUri)?.getValue()).toBe('');
  });

  it('clears a staged git model when the index no longer contains the file', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const projectId = 'project';
    const workspaceId = 'workspace';
    const root = `workspace:${workspaceId}`;
    const filePath = 'file.ts';
    const language = 'typescript';

    rpcState.indexContent = 'new file contents';
    const uri = await registry.registerModel(
      projectId,
      workspaceId,
      root,
      filePath,
      language,
      'git',
      STAGED_REF
    );
    const stagedUri = registry.toGitUri(uri, STAGED_REF);

    expect(registry.getModelByUri(stagedUri)?.getValue()).toBe('new file contents');

    rpcState.indexContent = null;
    await registry.invalidateModel(stagedUri);

    expect(registry.getModelByUri(stagedUri)?.getValue()).toBe('');
  });

  it('clears a non-staged git model when the ref no longer contains the file', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);

    const projectId = 'project';
    const workspaceId = 'workspace';
    const root = `workspace:${workspaceId}`;
    const filePath = 'file.ts';
    const language = 'typescript';

    rpcState.refContent = 'head file contents';
    const uri = await registry.registerModel(
      projectId,
      workspaceId,
      root,
      filePath,
      language,
      'git',
      HEAD_REF
    );
    const headUri = registry.toGitUri(uri, HEAD_REF);

    expect(registry.getModelByUri(headUri)?.getValue()).toBe('head file contents');

    rpcState.refContent = null;
    await registry.invalidateModel(headUri);

    expect(registry.getModelByUri(headUri)?.getValue()).toBe('');
  });

  // #6264:盘上的文件变了、编辑器里没有没存的修改 —— 缓冲区跟着换成新正文,只动变了的那一段。
  it('reloads an unchanged buffer from disk with a minimal edit', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    fileMocks.readFile.mockImplementationOnce(async () => ({
      success: true,
      data: { content: 'line one\nline two\n', binary: false, truncated: false, totalSize: 18 },
    }));
    const uri = await registry.registerModel('project', 'workspace', '/ws', 'a.txt', 'plaintext', 'disk');
    await registry.registerModel('project', 'workspace', '/ws', 'a.txt', 'plaintext', 'buffer');
    fileMocks.readFile.mockImplementationOnce(async () => ({
      success: true,
      data: { content: 'line one\nline 2\n', binary: false, truncated: false, totalSize: 16 },
    }));
    await registry.invalidateModel(registry.toDiskUri(uri));
    expect(registry.getValue(uri)).toBe('line one\nline 2\n');
    expect(registry.isDirty(uri)).toBe(false);
  });

  // 预览(HTML / markdown / SVG / CSV)只按 bufferVersions 重画:盘上换了正文,版本号必须跟着动,不然预览停在旧正文上。
  it('bumps the buffer version when a disk change lands in the buffer, so previews redraw', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    fileMocks.readFile.mockImplementationOnce(async () => ({
      success: true,
      data: { content: '<h1>ONE</h1>\n', binary: false, truncated: false, totalSize: 13 },
    }));
    const uri = await registry.registerModel('project', 'workspace', '/ws', 'page.html', 'html', 'disk');
    await registry.registerModel('project', 'workspace', '/ws', 'page.html', 'html', 'buffer');
    const before = registry.bufferVersions.get(uri) ?? 0;
    fileMocks.readFile.mockImplementationOnce(async () => ({
      success: true,
      data: { content: '<h1>TWO</h1>\n', binary: false, truncated: false, totalSize: 13 },
    }));
    await registry.invalidateModel(registry.toDiskUri(uri));
    expect(registry.getValue(uri)).toBe('<h1>TWO</h1>\n');
    expect(registry.bufferVersions.get(uri) ?? 0).toBeGreaterThan(before);
    expect(registry.isDirty(uri)).toBe(false);
  });

  // #6264:文件在盘上被删掉 —— 页签据此标「已删除」(正文留着);再读到就不再标。
  it('marks a buffer as deleted on disk when the file is gone, and clears it when it comes back', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    const uri = await registry.registerModel('project', 'workspace', '/ws', 'gone.md', 'markdown', 'disk');
    const diskUri = registry.toDiskUri(uri);

    fileMocks.readFile.mockImplementationOnce(async () => ({ success: false, error: { type: 'fs_error', message: 'ENOENT' } }) as never);
    fileMocks.fileExists.mockImplementationOnce(async () => ({ success: true, data: { exists: false, isDirectory: false } }));
    await registry.invalidateModel(diskUri);
    expect(registry.deletedOnDisk.has(uri)).toBe(true);

    await registry.invalidateModel(diskUri);
    expect(registry.deletedOnDisk.has(uri)).toBe(false);
  });

  // 读失败但文件还在(权限、一时没应答):❌ 标成已删除。
  it('does not call a file deleted when the read fails but the file still exists', async () => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    const uri = await registry.registerModel('project', 'workspace', '/ws', 'locked.md', 'markdown', 'disk');
    fileMocks.readFile.mockImplementationOnce(async () => ({ success: false, error: { type: 'fs_error', message: 'EACCES' } }) as never);
    await registry.invalidateModel(registry.toDiskUri(uri));
    expect(registry.deletedOnDisk.has(uri)).toBe(false);
  });

  // 摩擦单 F91(S23 L6-29):看板 App 和编辑器同开 TODO.md,编辑器里有没存的字时看板写了盘 —— 以前只能二选一,
  // Keep mine 把看板刚拖的卡退了回去。现在盘上的改动并进缓冲区,两边都留,缓冲区仍是没存,⌘S 写下并好的。
  const disk = (content: string) => ({ success: true, data: { content, binary: false, truncated: false, totalSize: content.length } });
  const openDirty = async (name: string, onDisk: string, mine: string) => {
    const registry = new MonacoModelRegistry();
    registry.notifyMonacoReady(makeFakeMonaco() as never);
    fileMocks.readFile.mockImplementationOnce(async () => disk(onDisk));
    const uri = await registry.registerModel('project', 'workspace', '/ws', name, 'markdown', 'disk');
    await registry.registerModel('project', 'workspace', '/ws', name, 'markdown', 'buffer');
    (registry.getModelByUri(uri) as unknown as FakeModel).setValue(mine);
    expect(registry.isDirty(uri)).toBe(true);
    return { registry, uri };
  };

  it('merges a disk change into unsaved edits: both kept, no choice to make, still unsaved', async () => {
    const { registry, uri } = await openDirty('TODO.md', '## 待办\n- [ ] a\n- [ ] b\n## 进行中\n', '## 待办\n- [ ] a (mine)\n- [ ] b\n## 进行中\n');
    // The board moved b to 进行中 on disk.
    fileMocks.readFile.mockImplementationOnce(async () => disk('## 待办\n- [ ] a\n## 进行中\n- [ ] b\n'));
    await registry.invalidateModel(registry.toDiskUri(uri));
    expect(registry.getValue(uri)).toBe('## 待办\n- [ ] a (mine)\n## 进行中\n- [ ] b\n');
    expect(registry.isDirty(uri)).toBe(true);
    expect(registry.getDiskValue(uri)).toBe('## 待办\n- [ ] a\n## 进行中\n- [ ] b\n');

    // ⌘S writes the merged text, and it is saved.
    expect(await registry.saveFileToDisk(uri)).toBe('## 待办\n- [ ] a (mine)\n## 进行中\n- [ ] b\n');
    expect(fileMocks.writeFile).toHaveBeenLastCalledWith('project', 'workspace', 'TODO.md', '## 待办\n- [ ] a (mine)\n## 进行中\n- [ ] b\n');
    expect(registry.isDirty(uri)).toBe(false);
  });

  it('where both changed the same text, both are there — not a letter of either lost', async () => {
    const { registry, uri } = await openDirty('n.md', 'title: x\n', 'title: mine\n');
    fileMocks.readFile.mockImplementationOnce(async () => disk('title: yours\n'));
    await registry.invalidateModel(registry.toDiskUri(uri));
    const merged = registry.getValue(uri)!;
    expect(merged).toContain('mine');
    expect(merged).toContain('yours');
    expect(merged).not.toContain('x');
  });

  it('a disk change that is the unsaved edit itself leaves nothing unsaved (and nothing doubled)', async () => {
    const { registry, uri } = await openDirty('s.md', 'a\n', 'a\nb\n');
    fileMocks.readFile.mockImplementationOnce(async () => disk('a\nb\n'));
    await registry.invalidateModel(registry.toDiskUri(uri));
    expect(registry.getValue(uri)).toBe('a\nb\n');
    expect(registry.isDirty(uri)).toBe(false);
  });

  // #6264:别的机器上的写入带着版本标记,盘上那份在读过之后被改过就拒(code: conflict)——重读一次,那边的改动
  // 并进你的缓冲区,再写下并好的:你按的那一下 ⌘S。❌ 当成普通失败吞掉,❌ 覆盖那边的。
  it('a write refused as stale re-reads the disk, merges it in, and writes the merged text', async () => {
    const { registry, uri } = await openDirty('c.txt', 'one\ntwo\n', 'one (mine)\ntwo\n');
    fileMocks.writeFile.mockImplementationOnce(async () => ({ success: false, error: { type: 'fs_error', message: 'changed', code: 'conflict' } }));
    fileMocks.readFile.mockImplementationOnce(async () => disk('one\ntwo (theirs)\n'));
    expect(await registry.saveFileToDisk(uri)).toBe('one (mine)\ntwo (theirs)\n');
    expect(fileMocks.writeFile).toHaveBeenLastCalledWith('project', 'workspace', 'c.txt', 'one (mine)\ntwo (theirs)\n');
    expect(registry.isDirty(uri)).toBe(false);
  });
});
