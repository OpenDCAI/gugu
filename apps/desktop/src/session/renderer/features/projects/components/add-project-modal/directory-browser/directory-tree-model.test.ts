import { describe, expect, it } from 'vitest';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import { directoryNodeName, subdirectoryPaths } from './directory-tree-model';

const entry = (name: string, type: DirectoryEntry['type']): DirectoryEntry => ({
  path: `/home/u/${name}`,
  name,
  type,
  size: 0,
  modifiedAt: new Date(0),
});

describe('subdirectoryPaths', () => {
  it('keeps directories only, visible ones first, each group sorted case-insensitively', () => {
    const paths = subdirectoryPaths([
      entry('zeta', 'directory'),
      entry('.cache', 'directory'),
      entry('notes.md', 'file'),
      entry('Alpha', 'directory'),
      entry('link', 'symlink'),
      entry('.Agents', 'directory'),
      entry('beta', 'directory'),
    ]);
    expect(paths).toEqual([
      '/home/u/Alpha',
      '/home/u/beta',
      '/home/u/zeta',
      '/home/u/.Agents',
      '/home/u/.cache',
    ]);
  });

  it('is empty when a directory has files only (the node then stops being a folder)', () => {
    expect(subdirectoryPaths([entry('a.ts', 'file'), entry('b.ts', 'file')])).toEqual([]);
  });
});

describe('directoryNodeName', () => {
  it('shows the root as its full path and children as their last segment', () => {
    expect(directoryNodeName('/home/u', '/home/u')).toBe('/home/u');
    expect(directoryNodeName('/home/u/projects/gugu', '/home/u')).toBe('gugu');
  });

  it('treats a trailing slash on the root as the same root', () => {
    expect(directoryNodeName('/home/u', '/home/u/')).toBe('/home/u');
  });
});
