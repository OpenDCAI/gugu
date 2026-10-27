import { describe, expect, it } from 'vitest';
import { identityPlace, shortenHome } from './sidebar-identity-place';

describe('身份卡「在哪」:设备 + 文件夹', () => {
  it('文件夹取会话自己的工作区,没有再退到项目目录,都没有是 null', () => {
    const base = { deviceLabel: 'd22', home: null };
    expect(identityPlace({ ...base, workspacePath: '/www/gugu-ver', projectPath: '/www/gugu' }).folder).toBe('/www/gugu-ver');
    expect(identityPlace({ ...base, workspacePath: undefined, projectPath: '/www/gugu' }).folder).toBe('/www/gugu');
    expect(identityPlace({ ...base, workspacePath: '', projectPath: null })).toEqual({ device: 'd22', folder: null, folderDisplay: null });
  });

  it('显示把主目录缩成 ~,复制用的仍是完整路径', () => {
    const place = identityPlace({ deviceLabel: '这台电脑', workspacePath: '/Users/mac1/gugu', projectPath: null, home: '/Users/mac1' });
    expect(place).toEqual({ device: '这台电脑', folder: '/Users/mac1/gugu', folderDisplay: '~/gugu' });
  });

  it('只认整段前缀:/Users/mac10 不是 /Users/mac1 底下;主目录本身是 ~;Windows 分隔符也认', () => {
    expect(shortenHome('/Users/mac10/x', '/Users/mac1')).toBe('/Users/mac10/x');
    expect(shortenHome('/Users/mac1', '/Users/mac1/')).toBe('~');
    expect(shortenHome('C:\\Users\\a\\proj', 'C:\\Users\\a')).toBe('~\\proj');
    expect(shortenHome('/root/x', null)).toBe('/root/x');
    expect(shortenHome('/x', '/')).toBe('/x');
  });
});
