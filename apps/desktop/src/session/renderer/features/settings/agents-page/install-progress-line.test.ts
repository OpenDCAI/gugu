import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { describe, expect, it } from 'vitest';
import { installProgressLine } from './install-progress-line';

// 英文 key 直接当文案返回，好让断言盯住「有没有这一段」而不是盯住措辞。
const translate = ((key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${Object.values(params).join(',')}` : key) as never;

const base: AgentInstallProgress = {
  providerId: 'codex',
  phase: 'downloading',
  elapsedMs: 3_000,
};

describe('installProgressLine', () => {
  it('有分母时给出「已完成 / 总共」和真实比例', () => {
    const line = installProgressLine(
      { ...base, bytesDone: 1024 * 1024 * 40, bytesTotal: 1024 * 1024 * 400, bytesPerSecond: 1024 * 1024 * 2 },
      translate
    );
    expect(line?.text).toContain('40.0 MB / 400.0 MB');
    expect(line?.text).toContain('2.0 MB/s');
    expect(line?.ratio).toBeCloseTo(0.1, 5);
  });

  /**
   * 判据（product spec）：拿不到分母就只报已完成量与速度，
   * **不展示估算出来的百分比** —— 一条停在 87% 不动的假进度条比没有更糟。
   */
  it('没有分母时只报已完成量与速度，比例是 null', () => {
    const line = installProgressLine(
      { ...base, bytesDone: 1024 * 1024 * 12, bytesPerSecond: 1024 * 512 },
      translate
    );
    expect(line?.ratio).toBeNull();
    expect(line?.text).toContain('12.0 MB');
    expect(line?.text).not.toContain('/ ');
    expect(line?.text).toContain('512.0 KB/s');
  });

  it('一个字节都没落地时只说阶段 —— 报「0 B」只会让人以为卡住了', () => {
    const line = installProgressLine({ ...base, phase: 'resolving', bytesDone: 0 }, translate);
    expect(line?.text).toBe('agentsPage.phaseResolving');
    expect(line?.ratio).toBeNull();
  });

  it('剩余时间按长短换单位', () => {
    expect(
      installProgressLine({ ...base, bytesDone: 10, bytesTotal: 100, etaSeconds: 12 }, translate)
        ?.text
    ).toContain('agentsPage.installEtaSeconds:12');
    expect(
      installProgressLine({ ...base, bytesDone: 10, bytesTotal: 100, etaSeconds: 150 }, translate)
        ?.text
    ).toContain('agentsPage.installEtaMinutes:3');
  });

  it('没有读数就没有这一行 —— 由调用方决定退回什么', () => {
    expect(installProgressLine(null, translate)).toBeNull();
  });

  it('比例不会超过 1（分母偏小的时候进度条不许溢出）', () => {
    const line = installProgressLine(
      { ...base, bytesDone: 500, bytesTotal: 100 },
      translate
    );
    expect(line?.ratio).toBe(1);
  });

  /** #6335:一次装两个程序 —— 先说是哪一个,比例只属于它(换到下一个时从头走,不是倒退)。 */
  it('一次装几个程序时带上「哪一个 · 第几个」,比例只算当前这个', () => {
    const line = installProgressLine(
      {
        ...base,
        bytesDone: 1024 * 1024 * 10,
        bytesTotal: 1024 * 1024 * 40,
        part: { index: 2, count: 2, name: 'Antigravity CLI' },
      },
      translate
    );
    expect(line?.text.startsWith('Antigravity CLI 2/2 · ')).toBe(true);
    expect(line?.ratio).toBeCloseTo(0.25, 5);
  });
});
