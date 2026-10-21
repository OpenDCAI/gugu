import type { HostDependencyLeg } from '@gugu/session-core/deps';

/** Why a harness cannot be spawned right now. The two reasons point the user in opposite directions. */
export type HarnessUnavailable = {
  /** `updating`: present but mid-replacement, clears itself. `missing`: really not installed. */
  reason: 'updating' | 'missing';
  providerId: string;
  /** The binary we looked for, as the product should name it to the user. */
  harnessName: string;
  /** The resolver's own diagnostic, verbatim — the exhausted locations, never translated. */
  detail: string;
};

/**
 * Ask, right now, whether a harness can be spawned on this machine.
 *
 * Deliberately re-runs the real resolution instead of reading the dependency probe's snapshot.
 * The snapshot is taken at app start and when the Agents settings page opens, so it answers
 * "was it installed earlier", which is a different question: on #5173 the snapshot said claude
 * was installed — it had been, seconds earlier — while the copy was being swapped out underneath.
 * A gate built on that snapshot lets exactly this failure through.
 *
 * Sharing `resolveAgentExecutable` with the spawn path is the point: a check that resolved
 * differently from the spawn would trade one wrong answer for another.
 *
 * ⚠️ 依赖一律**函数内动态 import**,❌ 别改回顶层静态 import。
 * `host-dependency-store` 那条链上有模块在**加载时**就构造读库的单例
 * (`ssh-credential-service` → `EncryptedAppSecretsStore`,它在模块顶层 new 出来并访问 `db`)。
 * 顶层引进来 = 把这条副作用带进 `createSession` 的模块图,于是 `import-session-persist.db.test.ts`
 * 在 import 阶段就抛 `Test database not initialized`,整个套件一条用例都跑不到。
 * 实测:改成静态 import 后该套件由 2 passed 变成 0 test + suite failed。
 *
 * Returns `null` when the harness is available. Only the two harness verdicts are caught —
 * anything else propagates, because this is an extra gate and swallowing an unexpected failure
 * here would only hide it from the spawn that follows.
 */
export async function checkLocalHarnessAvailable(
  providerId: string,
  /** 要起的是哪条腿 —— 两条腿可以是两个程序(#6335),问错了腿就是替另一个程序作保。 */
  leg: HostDependencyLeg,
): Promise<HarnessUnavailable | null> {
  const [
    { getPlugin },
    { agentProgramFor },
    { localDependencyManager },
    { hostDependencyStore },
    { LocalExecutionContext },
    { HarnessNotInstalledError, HarnessUpdatingError, resolveAgentExecutable },
  ] = await Promise.all([
    import('@main/core/agents/plugin-registry'),
    import('@gugu/session-core/deps/runtime'),
    import('@main/core/dependencies/dependency-managers'),
    import('@main/core/dependencies/host-dependency-store'),
    import('@main/core/execution-context/local-execution-context'),
    import('./resolve-agent-executable'),
  ]);

  // Assembled exactly as the spawn site does (local-session.ts), so the gate and the spawn
  // cannot disagree about which copy they are talking about.
  const { dependencyId, binaryName } = agentProgramFor(getPlugin(providerId), leg);

  const ctx = new LocalExecutionContext();
  try {
    await resolveAgentExecutable({
      providerId,
      dependencyId,
      binaryName,
      ctx,
      hostDependencyStore,
      cachedStatePath: localDependencyManager.get(dependencyId as never)?.path,
      installations: localDependencyManager.getHostDependency(dependencyId as never)?.installations,
    });
    return null;
  } catch (error) {
    if (error instanceof HarnessUpdatingError) {
      return {
        reason: 'updating',
        providerId,
        harnessName: error.harnessName,
        detail: error.message,
      };
    }
    if (error instanceof HarnessNotInstalledError) {
      return {
        reason: 'missing',
        providerId,
        harnessName: error.harnessName,
        detail: error.message,
      };
    }
    throw error;
  } finally {
    ctx.dispose();
  }
}
