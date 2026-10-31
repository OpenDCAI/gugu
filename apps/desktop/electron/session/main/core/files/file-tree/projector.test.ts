import { describe, expect, it } from 'vitest';
import type { FileNode, FileTreeUpdate, IFileTree, NodeId } from '@gugu/session-core/files';
import { ok } from '@gugu/session-shared';
import { FileTreeProjector } from './projector';

const node = (id: NodeId, path: string, parentId: NodeId | null, type: 'file' | 'directory'): FileNode => ({
  id,
  path,
  name: path.split('/').pop()!,
  parentId,
  childrenLoaded: false,
  type,
});

/** A tree of /w: `src/` (holding `a.ts`) and `README.md`; a folder's children come in when it is registered. */
function fakeTree() {
  const top = [node(1, '/w/src', null, 'directory'), node(2, '/w/README.md', null, 'file')];
  const inSrc = [node(3, '/w/src/a.ts', 1, 'file')];
  let listener: (update: FileTreeUpdate) => void = () => undefined;
  const registered: (NodeId | null)[] = [];
  const tree = {
    rootPath: '/w',
    ready: async () => ok<void>(),
    subscribe: (cb: (update: FileTreeUpdate) => void) => {
      listener = cb;
      cb({ kind: 'snapshot', entries: top.map((n) => [n.id, n] as const) } as unknown as FileTreeUpdate);
      return () => undefined;
    },
    registerDir: async (dirId: NodeId | null) => {
      registered.push(dirId);
      if (dirId === 1) listener({ kind: 'delta', ops: inSrc.map((n) => ({ op: 'put', key: n.id, value: n })) } as unknown as FileTreeUpdate);
      return ok({} as never);
    },
    unregisterDir: async () => ok({} as never),
    revealPath: async () => ok({} as never),
  } as unknown as IFileTree;
  return { tree, registered };
}

describe('FileTreeProjector.listDir: one folder of the tree, as an App lists it', () => {
  it('lists the top, then a folder only when asked for it — the folder is registered, nothing else is walked', async () => {
    const { tree, registered } = fakeTree();
    const projector = new FileTreeProjector(tree, () => undefined);
    const opened = await projector.openProjection();
    if (!opened.success) throw new Error('open failed');
    const top = await projector.listDir(opened.data.subscriptionId, null);
    expect(top.success && top.data.map((n) => n.path).sort()).toEqual(['/w/README.md', '/w/src']);
    expect(registered).toEqual([null]);
    const src = await projector.listDir(opened.data.subscriptionId, '/w/src');
    expect(src.success && src.data.map((n) => n.path)).toEqual(['/w/src/a.ts']);
    expect(registered).toEqual([null, 1]);
    expect(projector.scopePath(1)).toBe('/w/src');
    expect(projector.scopePath(null)).toBeNull();
  });

  it('a path that is no folder of the tree is not_found', async () => {
    const { tree } = fakeTree();
    const projector = new FileTreeProjector(tree, () => undefined);
    const opened = await projector.openProjection();
    if (!opened.success) throw new Error('open failed');
    expect(await projector.listDir(opened.data.subscriptionId, '/w/README.md')).toMatchObject({ success: false, error: { type: 'not_found' } });
    expect(await projector.listDir(opened.data.subscriptionId, '/w/nope')).toMatchObject({ success: false });
  });
});
