import { expect, it } from 'vitest';
import { workingCopyEntry } from './local-files';

it.each(['群公告.md', 'group-meta.json', 'todo.txt', 'banner.png'])('a task working-copy entry retains %s', name => {
  const entry = workingCopyEntry({ workspace: 'session:task' }, `docs/${name}`, null);
  expect(entry).toMatchObject({
    id: `docs/${name}`, path: `docs/${name}`, name, savedName: name, displayName: name,
    workspace: 'session:task',
  });
});

it('a file system that keeps no creation time leaves it unknown, not 1970', () => {
  const stat = { size: 1, birthtimeMs: 0, birthtime: new Date(0), mtime: new Date(1000) } as never;
  expect(workingCopyEntry({ workspace: 'session:task' }, 'a.md', stat)).toMatchObject({ createdAt: null, updatedAt: new Date(1000).toISOString() });
});
