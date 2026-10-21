import { describe, expect, it } from 'vitest';
import {
  RECENT_FOLDERS_STORAGE_KEY,
  loadRecentFolders,
  parseRecentFolders,
  pushRecentFolder,
  saveRecentFolders,
} from './remote-recent-folders';

describe('每台机器最近用过的文件夹(#6264 新建框一键再选)', () => {
  it('新的放最前、同一路径只留一条(末尾斜杠不算差别)、按机器分开、有上限', () => {
    let value = pushRecentFolder({}, 'dev-1', '/srv/a');
    value = pushRecentFolder(value, 'dev-1', '/srv/b/');
    value = pushRecentFolder(value, 'dev-1', '/srv/a/');
    value = pushRecentFolder(value, 'dev-2', '/home/x');
    expect(value).toEqual({ 'dev-1': ['/srv/a', '/srv/b'], 'dev-2': ['/home/x'] });
    let many = {};
    for (let i = 0; i < 12; i += 1) many = pushRecentFolder(many, 'd', `/p${i}`, 3);
    expect(many).toEqual({ d: ['/p11', '/p10', '/p9'] });
  });

  it('存储里形状不对的内容一律丢掉,读写失败不抛(新建框不能因此打不开)', () => {
    expect(parseRecentFolders('not json')).toEqual({});
    expect(parseRecentFolders('[1,2]')).toEqual({});
    expect(parseRecentFolders(JSON.stringify({ a: ['/x', 3, ''], b: 'nope' }))).toEqual({ a: ['/x'] });
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
    };
    expect(loadRecentFolders(throwing)).toEqual({});
    expect(() => saveRecentFolders(throwing, { a: ['/x'] })).not.toThrow();
  });

  it('重启后还在:写进去的就是下次读出来的', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveRecentFolders(storage, { 'dev-1': ['/srv/a'] });
    expect(store.has(RECENT_FOLDERS_STORAGE_KEY)).toBe(true);
    expect(loadRecentFolders(storage)).toEqual({ 'dev-1': ['/srv/a'] });
  });
});
