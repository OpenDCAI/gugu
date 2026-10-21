import { describe, expect, it } from 'vitest';
import { probeInstallSources, rankInstallSources } from './install-source-race';

type Verdict = { version: string | null; platformBuild: 'ok' | 'missing' | 'unknown' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 三个假源:一个慢、一个坏、一个好。判据是 spec 里那条:「三个源里一个慢、一个坏,
 * 必须选中剩下那个。」
 *
 * 用**真定时器**跑真并发,不是喂一组事先编好的 elapsedMs —— 要判的正是「计时这件事有没有
 * 真的发生」,喂数字的话 `probeInstallSources` 里就算一个字都不量,用例照样绿。
 */
function machine(timings: Record<string, { ms: number; verdict: Verdict }>) {
  const calls: string[] = [];
  return {
    calls,
    probe: async (registry: string): Promise<Verdict> => {
      calls.push(registry);
      const entry = timings[registry]!;
      await sleep(entry.ms);
      return entry.verdict;
    },
  };
}

const healthy: Verdict = { version: '2.0.0', platformBuild: 'ok' };
/** 源答不出版本 —— 超时、5xx、DNS 挂了,`fetchLatestVersion` 都把它们折成 null。 */
const silent: Verdict = { version: null, platformBuild: 'unknown' };

describe('安装前给各下载源计时,谁先正确答出来用谁', () => {
  it('一个慢、一个坏 ⇒ 选中剩下那个健康的', async () => {
    const m = machine({
      slow: { ms: 90, verdict: healthy },
      broken: { ms: 1, verdict: silent },
      quick: { ms: 5, verdict: healthy },
    });
    const probes = await probeInstallSources(['slow', 'broken', 'quick'], m.probe);

    // 并发,不是挨个探:挨个探的话慢的那个会把后面每个源的读数都推迟,量出来的先后反映的
    // 是排队顺序而不是源的快慢。三条都已经发出去 = 它们同时在跑。
    expect(m.calls).toEqual(['slow', 'broken', 'quick']);
    expect(rankInstallSources(probes)).toEqual(['quick', 'slow', 'broken']);
  });

  it('阳控:把快慢对调,选中的也跟着换 —— 排序读的是计时,不是声明顺序', async () => {
    // 没有这一条,上面那条绿也可能只是因为「按声明顺序 + 答不出的放最后」。
    const m = machine({
      slow: { ms: 5, verdict: healthy },
      broken: { ms: 1, verdict: silent },
      quick: { ms: 90, verdict: healthy },
    });
    const probes = await probeInstallSources(['slow', 'broken', 'quick'], m.probe);
    expect(rankInstallSources(probes)).toEqual(['slow', 'quick', 'broken']);
  });

  it('答不出版本的源排在后面,但仍然可以当重试候选', async () => {
    // 「问不到版本」不等于「装不了」—— 可能只是那一刻被限流了。❌ 不把它整个划掉。
    const m = machine({
      broken: { ms: 1, verdict: silent },
      quick: { ms: 5, verdict: healthy },
    });
    const probes = await probeInstallSources(['broken', 'quick'], m.probe);
    expect(rankInstallSources(probes)).toEqual(['quick', 'broken']);
  });

  it('确定缺本机平台包的源一次都不能用 —— 哪怕它最快', async () => {
    // 从它装会「成功」,然后留下一个没有二进制的启动器(product spec)。
    const m = machine({
      fastButEmpty: { ms: 1, verdict: { version: '2.0.0', platformBuild: 'missing' } },
      quick: { ms: 40, verdict: healthy },
    });
    const probes = await probeInstallSources(['fastButEmpty', 'quick'], m.probe);
    expect(rankInstallSources(probes)).toEqual(['quick']);
  });

  it('一个能用的都不剩时退回声明顺序,❌ 不返回空数组把安装堵死', async () => {
    const m = machine({
      a: { ms: 1, verdict: { version: '2.0.0', platformBuild: 'missing' } },
      b: { ms: 2, verdict: { version: '2.0.0', platformBuild: 'missing' } },
    });
    const probes = await probeInstallSources(['a', 'b'], m.probe);
    expect(rankInstallSources(probes)).toEqual(['a', 'b']);
  });

  it('一个源都没有时答一个空数组(调用方据此走 descriptor 的推荐源)', () => {
    expect(rankInstallSources([])).toEqual([]);
  });
});
