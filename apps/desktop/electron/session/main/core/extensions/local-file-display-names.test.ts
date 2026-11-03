import { expect, it } from 'vitest';
import { workingCopyEntry } from './local-files';

it.each(['群公告.md', 'group-meta.json', 'todo.txt', 'banner.png'])('a task working-copy entry retains %s', name => {
  const entry = workingCopyEntry({ workspace: 'session:task' }, `docs/${name}`, null);
  expect(entry).toMatchObject({
    id: `docs/${name}`, path: `docs/${name}`, name, savedName: name, displayName: name,
    workspace: 'session:task',
  });
});
