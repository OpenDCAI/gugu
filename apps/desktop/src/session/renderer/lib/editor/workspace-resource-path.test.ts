import { describe, expect, it } from 'vitest';
import { isOutsideWorkspace, resolveWorkspaceResourcePath } from './workspace-resource-path';

const workspacePath = '/repo';

describe('resolveWorkspaceResourcePath', () => {
  it('resolves relative resources against the containing file directory', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/readme.md',
        resourcePath: 'images/logo.png',
      })
    ).toBe('/repo/docs/images/logo.png');
  });

  it('anchors root-anchored resources at the workspace root, not the machine root', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/readme.md',
        resourcePath: '/assets/a.png',
      })
    ).toBe('/repo/assets/a.png');
  });

  it('resolves parent traversal that stays inside the workspace', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/readme.md',
        resourcePath: '../assets/a.png',
      })
    ).toBe('/repo/assets/a.png');
  });

  it('returns null when a resource escapes the workspace root', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/readme.md',
        resourcePath: '../secrets.txt',
      })
    ).toBeNull();
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/readme.md',
        resourcePath: '/../../etc/passwd',
      })
    ).toBeNull();
  });

  it('returns null for external and special references', () => {
    for (const resourcePath of [
      'https://example.com/a.png',
      'data:image/png;base64,xxxx',
      'mailto:a@b.com',
      '//cdn.example.com/a.png',
      '#anchor',
    ]) {
      expect(
        resolveWorkspaceResourcePath({
          workspacePath,
          containingFilePath: '/repo/readme.md',
          resourcePath,
        })
      ).toBeNull();
    }
  });

  it('fails closed when the workspace root is unknown', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath: undefined,
        containingFilePath: '/repo/readme.md',
        resourcePath: 'images/logo.png',
      })
    ).toBeNull();
  });

  it('strips query and fragment before resolving', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/readme.md',
        resourcePath: 'images/logo.png?v=2#x',
      })
    ).toBe('/repo/images/logo.png');
  });

  it('supports Windows-drive workspace roots', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath: 'C:/repo',
        containingFilePath: 'C:/repo/docs/readme.md',
        resourcePath: '/assets/a.png',
      })
    ).toBe('C:/repo/assets/a.png');
  });
});

// #5814 —— 承载文档在工作区之外(用户自己从磁盘打开的页面)。
// 那道工作区闸是圈 agent 的;套到用户自己的文件上,页面引用的图就永远裂图。
describe('resolveWorkspaceResourcePath · 工作区之外的文档', () => {
  const outside = '/tmp/scratch/report.html';

  it('相对路径按文档自己的目录解析,不按工作区', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: outside,
        resourcePath: 'shots/a.png',
      })
    ).toBe('/tmp/scratch/shots/a.png');
  });

  it('认 file: URL,并按本机绝对路径解析', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: outside,
        resourcePath: 'file:///Users/me/Desktop/a.png',
      })
    ).toBe('/Users/me/Desktop/a.png');
  });

  it('file: URL 里的百分号转义要还原(中文目录名)', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: outside,
        resourcePath: 'file:///Users/me/%E5%9B%BE%E7%89%87/a.png',
      })
    ).toBe('/Users/me/图片/a.png');
  });

  it('绝对路径按本机路径解析,不再按工作区根', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: outside,
        resourcePath: '/Users/me/Desktop/a.png',
      })
    ).toBe('/Users/me/Desktop/a.png');
  });

  it('向上回溯到文档目录之外也放行 —— 都是用户自己的文件', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: outside,
        resourcePath: '../other/a.png',
      })
    ).toBe('/tmp/other/a.png');
  });

  it('远端地址仍然一律拒掉', () => {
    for (const resourcePath of [
      'https://example.com/a.png',
      'data:image/png;base64,xxxx',
      '//cdn.example.com/a.png',
      '#anchor',
    ]) {
      expect(
        resolveWorkspaceResourcePath({
          workspacePath,
          containingFilePath: outside,
          resourcePath,
        })
      ).toBeNull();
    }
  });
});

describe('resolveWorkspaceResourcePath · 工作区内的文档不受影响', () => {
  it('file: URL 指向工作区外时照旧拒掉', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/a.html',
        resourcePath: 'file:///etc/passwd',
      })
    ).toBeNull();
  });

  it('file: URL 指向工作区内时放行', () => {
    expect(
      resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: '/repo/docs/a.html',
        resourcePath: 'file:///repo/assets/a.png',
      })
    ).toBe('/repo/assets/a.png');
  });
});

describe('isOutsideWorkspace', () => {
  it('分得清圈里圈外', () => {
    expect(isOutsideWorkspace('/repo', '/repo/a.html')).toBe(false);
    expect(isOutsideWorkspace('/repo', '/tmp/a.html')).toBe(true);
    // 前缀像但不是同一个目录 —— `/repo2` 不在 `/repo` 里。
    expect(isOutsideWorkspace('/repo', '/repo2/a.html')).toBe(true);
  });

  it('工作区未知时按圈内处理,走更保守的读取路径', () => {
    expect(isOutsideWorkspace(undefined, '/tmp/a.html')).toBe(false);
  });
});
