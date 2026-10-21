import { describe, expect, it } from 'vitest';
import { resolveHarnessState } from './harness-state';

const base = {
  reading: 'installed' as const,
  status: 'available' as const,
  busy: false,
  updateAvailable: false,
};

describe('resolveHarnessState', () => {
  it('一家只答一种状态:装上了就是「已安装」', () => {
    expect(resolveHarnessState(base)).toBe('installed');
  });

  it('有新版本压过「已安装」—— 那是用户下一步要做的事', () => {
    expect(resolveHarnessState({ ...base, updateAvailable: true })).toBe('update-available');
  });

  it('正在装压过一切:装的时候不谈版本', () => {
    expect(resolveHarnessState({ ...base, busy: true, updateAvailable: true })).toBe('installing');
    expect(
      resolveHarnessState({ ...base, busy: true, reading: 'not-detected', status: 'missing' }),
    ).toBe('installing');
  });

  it('文件在、跑不起来 = 「装了但起不来」,❌ 不是「未安装」', () => {
    // 这一条守的就是那个 bug 的形状:读成「未安装」用户就去装第二份,而第一份还在 PATH 前面。
    expect(
      resolveHarnessState({ ...base, reading: 'detected-but-broken', status: 'error' }),
    ).toBe('broken');
    // 阴控:同一个 reading 配 available 的 status 仍然是坏态 —— 坏态由 reading 说,
    // ❌ 不许被「运行时回落到别的副本」这件事盖掉。
    expect(
      resolveHarnessState({ ...base, reading: 'detected-but-broken', status: 'available' }),
    ).toBe('broken');
  });

  it('选中那一份没了、但机器上还有能跑的 ⇒ 已安装(咕咕确实跑得起来)', () => {
    // `status` 已经带着回落自动解析那一步。面板写「未安装」而咕咕照样把它跑起来,是 #4271
    // 那条「面板显示哪一份,咕咕就启动哪一份」的反面。
    expect(resolveHarnessState({ ...base, reading: 'missing', status: 'available' })).toBe(
      'installed',
    );
  });

  it('一份都没找到 = 未安装', () => {
    expect(
      resolveHarnessState({ ...base, reading: 'not-detected', status: 'missing' }),
    ).toBe('not-installed');
  });

  it('咕咕动不了的那一家不挂「有新版本」', () => {
    // 调用方按「这一家有没有托管安装」把 updateAvailable 压成 false —— 这里守的是
    // 「压成 false 之后确实不再是 update-available」,免得两处判据各自漂。
    expect(resolveHarnessState({ ...base, updateAvailable: false })).toBe('installed');
  });
});
