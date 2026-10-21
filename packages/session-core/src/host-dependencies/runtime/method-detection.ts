import type { IExecutionContext } from '../../exec/execution-context';
import type { InstallTarget, Platform } from '../capability';
import { inferMethod } from './location-hints';
import { resolveCommandPath } from './probe';
import type { Provenance } from './types';

const DETECT_TIMEOUT_MS = 5_000;

async function queryDir(
  ctx: IExecutionContext,
  command: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stdout } = await ctx.exec(command, args, { timeout: DETECT_TIMEOUT_MS });
    return stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export type InstallMethodDetector = {
  /** Detect the provenance of a binary at the given realpath. Never throws. */
  detect(realPath: string): Promise<Provenance>;
  /**
   * Invalidate cached package-manager root queries so the next detect() call
   * re-queries. Call after install/uninstall to pick up changes.
   */
  invalidate(): void;
  /** Locate the binary files owned by a declared package-manager target. */
  locateTarget?(target: InstallTarget, binaryNames: string[]): Promise<string[]>;
};

/**
 * Creates a per-host install provenance detector that queries brew and npm for their
 * root/prefix directories, then uses those roots to definitively classify a binary's
 * realpath before falling back to path-substring heuristics.
 *
 * Returns a full Provenance object (kind + confidence + optional managerRef) instead
 * of just an InstallMethod. 'confirmed' confidence means a package-manager query
 * confirmed ownership; 'inferred' means path-substring heuristics only.
 *
 * Detection order:
 *   0. realpath under a root WE installed into → npm, confirmed（见 ownedNpmRoots）
 *   1. realpath under `brew --cellar`    → homebrew, confirmed, managerRef = formula
 *   2. realpath under Caskroom paths     → homebrew, confirmed, managerRef = cask
 *   3. realpath under `brew --prefix`/opt → homebrew, confirmed (formula opt-prefix)
 *   4. realpath under `npm root -g`      → npm, confirmed
 *   5. fallback to inferMethod(realPath, platform) heuristics → inferred
 *   6. unknown if no heuristic matches   → unknown, inferred
 *
 * Cache strategy: the brew/npm root queries are memoized per detector lifetime, a failed
 * (null) answer included. Every failure is treated as transient — `invalidate()` clears the
 * cache and the next detect() re-queries. ❌ 别再加一层「确认性失败、永不重试」的标记:
 * 那三个 flag 在这里存在过，而它们在失败分支里被赋的是 `false` ⇒ 守着它们的三个 if 恒不成立。
 */
export function createInstallMethodDetector(
  ctx: IExecutionContext,
  platform: Platform,
  options: {
    /**
     * `node_modules` roots this app installs into itself. A copy living under one of them was
     * put there by us, so it is **confirmed** npm — no query needed, and `npm root -g` would not
     * find it anyway (that answers for the *user's* prefix, not ours). Without this, the copies
     * we own would be the only ones stuck at 'inferred', which is backwards.
     */
    ownedNpmRoots?: string[];
    /**
     * npm 把可执行文件放在哪 —— POSIX 上 `<prefix>/bin` 里是指向 `lib/node_modules` 的**软链**,
     * realpath 一跟就落回上面那个 root;Windows 上放的是 `<prefix>\x.cmd` 这种 **shim 脚本**,
     * 不是软链,realpath 跟不动,于是咕咕自己刚装的那一份永远判不成「我们装的」——
     * `manageable` 跟着为假,面板当着用户的面说「这一份不是咕咕装的」,更新和卸载一并变灰。
     * 所以这些目录要单独登记一份。
     */
    ownedShimDirs?: string[];
    ownedMiseBinDirs?: string[];
  } = {}
): InstallMethodDetector {
  // undefined = not yet fetched; null = confirmed absent/failed; string = valid path
  let brewCellarCache: string | null | undefined;
  let brewPrefixCache: string | null | undefined;
  let npmRootCache: string | null | undefined;

  async function brewCellar(): Promise<string | null> {
    if (brewCellarCache !== undefined) return brewCellarCache;
    brewCellarCache = platform !== 'windows' ? await queryDir(ctx, 'brew', ['--cellar']) : null;
    return brewCellarCache;
  }

  async function brewPrefix(): Promise<string | null> {
    if (brewPrefixCache !== undefined) return brewPrefixCache;
    brewPrefixCache = platform !== 'windows' ? await queryDir(ctx, 'brew', ['--prefix']) : null;
    return brewPrefixCache;
  }

  async function npmRoot(): Promise<string | null> {
    if (npmRootCache !== undefined) return npmRootCache;
    npmRootCache = await queryDir(ctx, 'npm', ['root', '-g']);
    return npmRootCache;
  }

  /**
   * 比较一律在「小写 + 正斜杠」这一种写法上做。❌ 不要只 toLowerCase ——
   * Windows 给的是 `C:\Users\...`,而下面用的是 `norm + '/'`,不归一就**一条也匹配不上**,
   * 而且失败得悄无声息:所有 owned root 判空,咕咕自己装的副本全被当成别人的。
   */
  function normalizeDir(dir: string): string {
    return dir.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function pathStartsWith(lower: string, dir: string): boolean {
    const norm = normalizeDir(dir);
    return lower.startsWith(norm + '/') || lower === norm;
  }

  /** Extract a segment of a path that follows a known prefix directory. */
  function extractSegmentAfterPrefix(realPath: string, prefix: string): string | undefined {
    const norm = normalizeDir(prefix);
    const lower = normalizeDir(realPath);
    if (!pathStartsWith(lower, norm)) return undefined;
    // Get the actual casing from the original realPath
    const rest = realPath.slice(norm.length).replace(/^[\\/]+/, '');
    // First path segment = formula/cask name
    return rest.split(/[\\/]/)[0] ?? undefined;
  }

  return {
    async detect(realPath: string): Promise<Provenance> {
      const lower = normalizeDir(realPath);

      for (const owned of options.ownedMiseBinDirs ?? []) {
        if (pathStartsWith(lower, owned)) return { kind: 'mise', confidence: 'confirmed', ours: true };
      }

      // 0. A root we installed into ourselves — we placed it, so this is not a guess.
      for (const owned of [...(options.ownedNpmRoots ?? []), ...(options.ownedShimDirs ?? [])]) {
        // `ours` 是这里唯一能给出的东西 —— 下面几条(brew cellar / 用户的 npm root)同样是
        // confirmed,但那是别人装的。咕咕只维护自己装的那一份,所以两者必须分得开。
        if (pathStartsWith(lower, owned)) {
          return { kind: 'npm', confidence: 'confirmed', ours: true };
        }
      }

      // 1. Homebrew Cellar (formulas)
      const cellar = await brewCellar();
      if (cellar && pathStartsWith(lower, cellar)) {
        const managerRef = extractSegmentAfterPrefix(realPath, cellar);
        return { kind: 'homebrew', confidence: 'confirmed', managerRef };
      }

      // 2. Homebrew Caskroom paths — check prefix/Caskroom and prefix/opt
      const prefix = await brewPrefix();
      if (prefix) {
        const caskroom = prefix + '/Caskroom';
        if (pathStartsWith(lower, caskroom)) {
          const managerRef = extractSegmentAfterPrefix(realPath, caskroom);
          return { kind: 'homebrew', confidence: 'confirmed', managerRef };
        }
        const opt = prefix + '/opt';
        if (pathStartsWith(lower, opt)) {
          const managerRef = extractSegmentAfterPrefix(realPath, opt);
          return { kind: 'homebrew', confidence: 'confirmed', managerRef };
        }
      }

      // 3. npm global root
      const root = await npmRoot();
      if (root && pathStartsWith(lower, root)) {
        // managerRef: parent dir of node_modules is the package root; use descriptor later
        return { kind: 'npm', confidence: 'confirmed' };
      }

      // 4. Fallback to path-substring heuristics
      const inferred = inferMethod(realPath, platform);
      if (inferred !== null) {
        return { kind: inferred, confidence: 'inferred' };
      }

      // Version-manager shim detection (mise, asdf, nvm shims)
      if (
        lower.includes('/.asdf/shims/') ||
        lower.includes('/mise/shims/') ||
        lower.includes('/.rtx/shims/')
      ) {
        return { kind: 'version-manager', confidence: 'inferred' };
      }

      return { kind: 'unknown', confidence: 'inferred' };
    },

    invalidate(): void {
      brewCellarCache = undefined;
      brewPrefixCache = undefined;
      npmRootCache = undefined;
    },

    async locateTarget(target: InstallTarget, binaryNames: string[]): Promise<string[]> {
      if (target.kind === 'mise') {
        const found: string[] = [];
        for (const dir of options.ownedMiseBinDirs ?? []) {
          const launcher = await resolveCommandPath(dir + '/' + target.binary + (platform === 'windows' ? '.cmd' : ''), ctx, platform);
          if (launcher) found.push(launcher);
        }
        return found;
      }
      if (!/^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/.test(target.package)) return [];

      // 先看我们自己装东西的那棵树,再看用户的全局根。顺序不是偏好而是正确性:`npm root -g`
      // 答的是**用户**那个 prefix,而我们是带着自己的 `npm_config_prefix` 装的 —— 只问它,
      // 刚装好的包永远"找不到",安装/更新会在成功之后判定失败(真机复现过)。
      const roots = [...(options.ownedNpmRoots ?? [])];
      const globalRoot = await npmRoot();
      if (globalRoot) roots.push(globalRoot);
      if (roots.length === 0) return [];

      for (const root of roots) {
        const found = await binariesInRoot(root, target.package, binaryNames);
        if (found.length > 0) return found;
      }
      return [];
    },
  };

  async function binariesInRoot(
    root: string,
    packageName: string,
    binaryNames: string[],
  ): Promise<string[]> {
    // npm does not expose the installed package's bin path in `npm ls -g`; read the
    // package manifest that npm itself installed instead. The script runs through the
    // execution context so SSH and local hosts use the same transport boundary.
    const packageJson = `${root.replace(/[\\/]$/, '')}/${packageName}/package.json`;
    const script = [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "const file=process.argv[1];",
      "const pkg=JSON.parse(fs.readFileSync(file,'utf8'));",
      "const bin=typeof pkg.bin==='string'?{[String(pkg.name||'').split('/').pop()]:pkg.bin}:(pkg.bin||{});",
      "for(const [name,value] of Object.entries(bin)) if(typeof value==='string') console.log(name+'\\t'+path.resolve(path.dirname(file),value));",
    ].join('');
    try {
      const { stdout } = await ctx.exec('node', ['-e', script, packageJson], {
        timeout: DETECT_TIMEOUT_MS,
      });
      const wanted = new Set(binaryNames);
      return stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split('\t'))
        .filter(([name, value]) => !!name && !!value && wanted.has(name!))
        .map(([, value]) => value!)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
