import { describe, expect, it } from 'vitest';
import { nameTwinIds } from './name-twins';

describe('nameTwinIds(桌面侧栏与手机「项目」页同一个同名判据)', () => {
  it('只有与别的行同名的那些行;没名字的不算', () => {
    const rows = [
      { id: 'a', name: 'Repo' },
      { id: 'b', name: 'Repo' },
      { id: 'c', name: 'Other' },
      { id: 'd', name: null },
      { id: 'e', name: null },
    ];
    expect([...nameTwinIds(rows)].sort()).toEqual(['a', 'b']);
    expect(nameTwinIds([{ id: 'a', name: 'Repo' }]).size).toBe(0);
  });
});
