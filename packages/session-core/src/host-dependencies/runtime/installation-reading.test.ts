import { describe, expect, it } from 'vitest';
import {
  deriveHostDependencyStatus,
  readHostDependency,
  readingFromStatus,
  type HostDependency,
  type Installation,
  type SelectedSource,
} from './types';

function installation(over: Partial<Installation> & { realpath: string }): Installation {
  return {
    id: over.realpath,
    pathEntry: over.realpath,
    isActive: false,
    manageable: false,
    provenance: { kind: 'unknown', confidence: 'inferred' },
    status: 'available',
    version: '1.0.0',
    latestVersion: null,
    updateAvailable: false,
    ...over,
  };
}

function hostDep(installations: Installation[], used: SelectedSource): HostDependency {
  return { hostId: 'local', dependencyId: 'codex', installations, used };
}

describe('readingFromStatus', () => {
  it('keeps 文件在但跑不起来 apart from 一份都没找到', () => {
    expect(readingFromStatus('available')).toBe('installed');
    expect(readingFromStatus('error')).toBe('detected-but-broken');
    expect(readingFromStatus('missing')).toBe('not-detected');
  });

  /**
   * 红控 = 改之前各处的判据:`status !== 'available'` 一刀切。
   * 它把「去修」和「去装」两件事折进同一个词,而用户的下一步完全不同 —— 照着「未安装」去装
   * 第二份,原来那份还在 PATH 前面,装完跑的还是它。
   */
  it('the old one-cut predicate cannot tell them apart', () => {
    const foldedByOldCode = (['error', 'missing'] as string[]).map((s) => s !== 'available');
    expect(foldedByOldCode).toEqual([true, true]);
    expect(new Set([readingFromStatus('error'), readingFromStatus('missing')]).size).toBe(2);
  });
});

describe('readHostDependency', () => {
  it('reads the copy the user picked', () => {
    const dep = hostDep(
      [installation({ realpath: '/a/codex', isActive: true })],
      { kind: 'auto' }
    );
    expect(readHostDependency(dep)).toBe('installed');
  });

  it('says 读不出版本 when the file is there but will not run', () => {
    const dep = hostDep(
      [installation({ realpath: '/a/codex', isActive: true, status: 'error', version: null })],
      { kind: 'auto' }
    );
    expect(readHostDependency(dep)).toBe('detected-but-broken');
  });

  it('says 一份都没找到 when nothing was discovered', () => {
    expect(readHostDependency(hostDep([], { kind: 'auto' }))).toBe('not-detected');
  });

  /**
   * 选中的是一个**具体目标**而它不在了 —— 而别的副本还在,运行时会回落到自动解析。
   * `status` 必须跟着运行时走(否则面板写「未安装」而咕咕照样把它跑起来),`reading` 要说出
   * 「你点的那一份没了」这件事本身。两个读数同时为真,答的是两个不同的问题。
   */
  it('separates “your pick is gone” from “nothing is installed”', () => {
    const dep = hostDep(
      [installation({ realpath: '/a/codex', isActive: true })],
      { kind: 'pinned', realpath: '/gone/codex' }
    );
    expect(readHostDependency(dep)).toBe('missing');
    expect(deriveHostDependencyStatus(dep)).toBe('available');
  });

  /** 「让咕咕装一份」是还没兑现的意向,不是丢了的目标 —— ❌ 不许读成「你选的那一份不在了」。 */
  it('does not call an unfulfilled install intent a gone copy', () => {
    const dep = hostDep(
      [installation({ realpath: '/a/codex', isActive: true })],
      { kind: 'method', method: 'npm' }
    );
    expect(readHostDependency(dep)).toBe('installed');
  });
});
