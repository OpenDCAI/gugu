import { opendir } from 'node:fs/promises';

/**
 * 挂载前的有界可达性探测。
 *
 * macOS 的 TCC 在没有授权时不会立刻拒绝 —— 它会把访问一直挂着等用户在系统弹窗上做决定。
 * 于是「项目放在 ~/Desktop / ~/Documents / ~/Downloads 下」时，挂载会一路阻塞到
 * `LOCAL_PROVIDER_TIMEOUT_MS` 耗尽，最后吐一句与真实原因无关的 `Operation timed out`，
 * 而且面板上没有任何恢复动作（#3611）。
 *
 * 授权之所以反复失效：beta 是 ad-hoc 签名、没有团队 ID，TCC 只能把授权钉在 cdhash 上，
 * 而 cdhash 每个构建都不同 —— 每更新一次就失效一次。根因要靠稳定签名身份解决，
 * 这里只负责把「被权限挡住」和「真的很慢」区分开，别让用户对着一句 timeout 干瞪眼。
 *
 * 用 opendir 而不是 stat：TCC 管的是目录内容的读取，stat 到路径本身未必触发检查。
 */

/** 探测预算。远小于挂载预算，好让「被挡住」在挂载超时之前就被判出来。 */
export const PATH_ACCESS_PROBE_TIMEOUT_MS = 3_000;

export type PathAccessProbe =
  | { kind: 'ok' }
  /** 探测在预算内没有返回 —— 典型是系统权限弹窗尚未被应答。 */
  | { kind: 'blocked' }
  | { kind: 'failed'; message: string };

export async function probePathAccess(
  path: string,
  timeoutMs: number = PATH_ACCESS_PROBE_TIMEOUT_MS
): Promise<PathAccessProbe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'blocked'>((resolve) => {
    timer = setTimeout(() => resolve('blocked'), timeoutMs);
  });

  try {
    // attempt 必须永不 reject：判为 blocked 之后就没人再 await 它了，届时一个迟到的
    // reject 会直接变成主进程的 unhandled rejection。所以 catch 挂在整条链末尾，
    // 而不是只当 opendir 的第二个参数——read 抛错同样要被收进 failed。
    const attempt = opendir(path)
      .then(async (dir) => {
        // 真读一条目录项：只 open 不 read 在某些实现下不足以触发内容级检查。
        try {
          await dir.read();
        } finally {
          await dir.close().catch(() => {});
        }
        return { kind: 'ok' } as const;
      })
      .catch((error: unknown) => ({
        kind: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      }));

    const outcome = await Promise.race([attempt, budget]);
    // 被判为 blocked 时不去 await attempt —— 它可能永远挂着（等弹窗）。
    return outcome === 'blocked' ? { kind: 'blocked' } : outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
