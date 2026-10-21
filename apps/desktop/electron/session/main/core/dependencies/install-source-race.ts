/**
 * 下载源不让用户选 —— 给安装前那趟「查最新版本」的请求计时,谁先正确答出来就用谁(#6157)。
 *
 * owner 原话:「下载源可以不让用户选,两边都试谁快选谁。」这条不需要新增任何网络往返:装之前
 * 本来就要对每个源各查一次最新版本(`fetchInstallSourceVersions`,面板一打开就发),
 * 这里只是把那一趟**顺手计时**,然后按用时排出本次下载的先后。
 *
 * 测法借自 nrm(`nrm test`,MIT):对每个 registry 发一次真实请求、计时、按用时排序;
 * 答不出来的不参与排名。❌ 不引它做依赖 —— 那是个 CLI,而这里要量的是我们自己已经在发的
 * 那一趟请求;抄它的**做法**,不抄它的代码。
 */

/** 一个源在那一趟里的表现。 */
export type InstallSourceProbe = {
  registry: string;
  /** 它说的最新版本;答不出来是 null(超时、5xx、DNS 挂了都落在这里)。 */
  version: string | null;
  /**
   * 这个源上有没有这台机器要的平台包。
   * `missing` 是**确定没有** —— 从它装会「成功」,然后留下一个没有二进制的启动器,
   * 所以它**一次都不能用**(product spec)。
   * `unknown` 是**没查出来**,不构成不可用。
   */
  platformBuild: 'ok' | 'missing' | 'unknown';
  /** 那一趟请求用了多久。 */
  elapsedMs: number;
  /** 它在声明顺序里的位次 —— 用时打平(缓存命中时全是 0ms)时按它决定先后。 */
  order: number;
};

/**
 * 本次下载按什么顺序试这些源。第一条就是这次要用的源,后面的是**换源重试**的候选。
 *
 * - 正确答出版本的排最前,按用时升序(用时相同按声明顺序);
 * - 答不出来的排在后面 —— 「问不到版本」不等于「装不了」(可能只是那一刻 429 了),
 *   所以它仍然可以当重试候选,只是不优先;
 * - `platformBuild === 'missing'` 的**整个排除**:从它装会静默地装出个空壳。
 * - 一条都不剩时退回声明顺序 —— ❌ 不返回空数组让安装无路可走:真正的失败该由安装那一步
 *   响亮地报出来,而不是在这里变成「没有源」。
 */
export function rankInstallSources(probes: readonly InstallSourceProbe[]): string[] {
  const usable = probes.filter((p) => p.platformBuild !== 'missing');
  if (usable.length === 0) {
    return [...probes].sort((a, b) => a.order - b.order).map((p) => p.registry);
  }
  const answered = usable.filter((p) => p.version !== null);
  const silent = usable.filter((p) => p.version === null);
  return [
    ...answered.sort((a, b) => a.elapsedMs - b.elapsedMs || a.order - b.order),
    ...silent.sort((a, b) => a.order - b.order),
  ].map((p) => p.registry);
}

/**
 * 并发发出那一趟请求并给每条计时。
 *
 * **并发**,不是挨个探:挨个探的话「慢的那个」会把后面每个源的读数都推迟,量出来的先后
 * 反映的是排队顺序而不是源的快慢;而且用户要多等一整串超时。
 */
export async function probeInstallSources<T extends { version: string | null; platformBuild: 'ok' | 'missing' | 'unknown' }>(
  registries: readonly string[],
  probe: (registry: string) => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<Array<InstallSourceProbe & { result: T }>> {
  return Promise.all(
    registries.map(async (registry, order) => {
      const started = now();
      const result = await probe(registry);
      return {
        registry,
        order,
        version: result.version,
        platformBuild: result.platformBuild,
        elapsedMs: now() - started,
        result,
      };
    }),
  );
}
