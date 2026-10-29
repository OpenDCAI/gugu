import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';

/**
 * 一家 harness 实际用的配置目录,认它自己在 hook 里报的(Claude:`transcript_path` = `<配置目录>/projects/<cwd>/<id>.jsonl`),
 * ❌ 只按宿主 / spawn 的 env 猜。`claude` 可能是个包装器(reclaude):`CLAUDE_CONFIG_DIR` 由它在进程里自己设,宿主的 env
 * 里没有,于是在场文件(`sessions/<pid>.json`)和会话记录都不在 `~/.claude` 下(10-28 Linux 2:「找不到 claude 会话记录」)。
 *
 * - 按会话记:这一条会话的在场读者先找它。
 * - 按家记(存进本机 kv,重启还在):读会话记录时把这一家见过的配置目录排在默认根后面一起找 —— 记录按会话 id 认,多找
 *   一个目录不会找错。最多留 `MAX_ROOTS` 个,新的在前。
 */
const MAX_ROOTS = 8;
const store = new KV<Record<string, string[]>>('harness-config-roots');
const bySession = new Map<string, string>();
const byProvider = new Map<string, string[]>();
let loaded: Promise<void> | null = null;

/** 本机记过的各家配置目录读进内存;启动时调一次,读侧(同步)只看内存。 */
export function loadHarnessConfigRoots(): Promise<void> {
  loaded ??= store
    .getAll()
    .then((all) => {
      for (const [providerId, roots] of Object.entries(all)) {
        if (Array.isArray(roots)) byProvider.set(providerId, mergeRoots(byProvider.get(providerId) ?? [], roots));
      }
    })
    .catch((error: unknown) => log.warn('harness config roots: the remembered roots could not be read', { error: String(error) }));
  return loaded;
}

function mergeRoots(first: readonly string[], then: readonly string[]): string[] {
  return [...new Set([...first, ...then].filter((root) => typeof root === 'string' && root.trim()))].slice(0, MAX_ROOTS);
}

/** harness 在这条会话的 hook 里报了它的配置目录:记下(按会话、按家),家里新出现的才落盘。 */
export function learnHarnessConfigRoot(input: { sessionId: string; providerId: string; root: string }): void {
  const root = input.root.trim();
  if (!root) return;
  bySession.set(input.sessionId, root);
  const known = byProvider.get(input.providerId) ?? [];
  if (known[0] === root) return;
  const next = mergeRoots([root], known);
  byProvider.set(input.providerId, next);
  void store.set(input.providerId, next);
}

/** 这条会话的 harness 报过的配置目录;还没报 = `undefined`。 */
export function harnessConfigRootOf(sessionId: string): string | undefined {
  return bySession.get(sessionId);
}

/** 这一家在本机报过的配置目录,新的在前。 */
export function knownHarnessConfigRoots(providerId: string | null | undefined): string[] {
  return providerId ? [...(byProvider.get(providerId) ?? [])] : [];
}

/** TEST-ONLY */
export function resetHarnessConfigRootsForTests(): void {
  bySession.clear();
  byProvider.clear();
  loaded = null;
}
