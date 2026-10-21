import type { ReleaseSource } from '@gugu/session-core/deps';
import { ACP_REGISTRY_URL, DEFAULT_NPM_REGISTRY_ID, npmRegistryUrl } from '@gugu/session-core/deps';
import type { Logger } from '@gugu/session-core/lib';
import { parseVendorManifest, vendorManifestUrl, vendorPlatformLookupKey } from './mise-distribution';

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry {
  version: string | null;
  expiresAt: number;
}

/**
 * Resolve an optionalDependency spec to the package + exact version to ask a registry for.
 *
 * Some launchers publish their platform builds as npm aliases —
 * `"@openai/codex-linux-x64": "npm:@openai/codex@0.147.0-linux-x64"` — where the "platform
 * package" is a *version* of the same package. Looking those up by dependency name 404s on every
 * registry, official included, which reads as "every mirror is broken" when nothing is wrong.
 */
function resolveAliasSpec(
  depName: string,
  spec: string,
): { name: string; version: string } | null {
  if (spec.startsWith('npm:')) {
    const rest = spec.slice('npm:'.length);
    const at = rest.lastIndexOf('@');
    if (at <= 0) return null;
    return { name: rest.slice(0, at), version: rest.slice(at + 1) };
  }
  // A bare exact version is the only other form these launchers use; a range would need
  // resolution we cannot do from one manifest, so treat it as unanswerable.
  return /^\d/.test(spec) ? { name: depName, version: spec } : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'gugu-latest-version',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

type PlatformBuildVerdict = 'ok' | 'missing' | 'unknown';

interface PlatformCacheEntry {
  verdict: PlatformBuildVerdict;
  expiresAt: number;
}


export class LatestVersionService {
  private cache = new Map<string, CacheEntry>();
  /**
   * Platform-build verdicts, same TTL as versions so the two halves of one source row do not age
   * apart — a cached version next to a freshly re-fetched availability check would make the menu
   * cost a round trip per open for no new information.
   */
  private platformCache = new Map<string, PlatformCacheEntry>();
  /**
   * 官方 ACP 注册表的整份索引(#6335)。一个文件列出全部 agent,所以**一次取回、所有家共用**,
   * 与版本同 TTL;并发的几家共用同一趟请求。失败不缓存(同 `probePlatformBuild` 的理由)。
   */
  private acpRegistry: { agents: Promise<Array<{ id?: unknown; version?: unknown }>>; expiresAt: number } | null = null;
  private logger?: Logger;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger;
  }

  /**
   * Fetch the latest published version for the given release source.
   * Returns null when the source is 'none', the network is unavailable, or any
   * error occurs — callers should treat null as "unknown" and hide update UI.
   *
   * `registryId` selects which npm registry to ask. It must be the registry the agent is
   * installed from: mirrors can lag behind the official registry (measured: a package sitting a
   * full major version back), and asking a newer registry while updating from an older one
   * produces an "update available" prompt that updating can never satisfy —
   * see product spec
   */
  async fetchLatestVersion(source: ReleaseSource, registryId?: string): Promise<string | null> {
    if (source.kind === 'none') return null;

    const cacheKey = this.cacheKeyFor(source, registryId);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.version;

    try {
      const version = await this.resolve(source, registryId);
      this.cache.set(cacheKey, { version, expiresAt: Date.now() + CACHE_TTL_MS });
      return version;
    } catch (err) {
      this.logger?.debug(`[latest-version] failed to fetch ${cacheKey}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Cache key. npm entries are keyed per registry — without that, a version read from one
   * registry would be served for another, which is exactly the mismatch this feature avoids.
   */
  private cacheKeyFor(source: ReleaseSource, registryId?: string): string {
    if (source.kind === 'npm') {
      return `npm:${source.package}@${registryId ?? DEFAULT_NPM_REGISTRY_ID}`;
    }
    if (source.kind === 'acp-registry') return `acp-registry:${source.agentId}`;
    if (source.kind === 'vendor-manifest') return `vendor-manifest:${source.manifest}`;
    return source.kind === 'github' ? `github:${source.repo}` : source.kind;
  }

  private acpRegistryAgents(): Promise<Array<{ id?: unknown; version?: unknown }>> {
    if (this.acpRegistry && Date.now() < this.acpRegistry.expiresAt) return this.acpRegistry.agents;
    const agents = fetchJson(ACP_REGISTRY_URL).then((json) => {
      const list = (json as { agents?: unknown }).agents;
      if (!Array.isArray(list)) throw new Error('ACP registry has no agent list');
      return list as Array<{ id?: unknown; version?: unknown }>;
    });
    const entry = { agents, expiresAt: Date.now() + CACHE_TTL_MS };
    this.acpRegistry = entry;
    agents.catch(() => { if (this.acpRegistry === entry) this.acpRegistry = null; });
    return agents;
  }

  private async resolve(source: ReleaseSource, registryId?: string): Promise<string | null> {
    if (source.kind === 'npm') {
      const selectedRegistry = registryId ?? DEFAULT_NPM_REGISTRY_ID;
      const base = npmRegistryUrl(selectedRegistry);
      if (!base) throw new Error(`Unknown npm registry: ${selectedRegistry}`);
      const url = `${base}/${encodeURIComponent(source.package)}/latest`;
      const json = (await fetchJson(url)) as { version?: string };
      return json.version ?? null;
    }

    if (source.kind === 'acp-registry') {
      const agent = (await this.acpRegistryAgents()).find((entry) => entry?.id === source.agentId);
      // 注册表里没有这一家 = 问到了、答案是「没有」;返回 null(未知),界面不报更新。
      return typeof agent?.version === 'string' ? agent.version : null;
    }

    if (source.kind === 'vendor-manifest') {
      // 问**本机那一格** —— 装的也是那一格(`resolveVendorManifestDistribution`),
      // 各平台发版节奏不必一致,拿别的平台的版本号来报「有更新」可能是一句永远兑现不了的话。
      const url = vendorManifestUrl(source, vendorPlatformLookupKey(process.platform, process.arch));
      if (!url) return null;
      return parseVendorManifest(await fetchJson(url)).version;
    }

    if (source.kind === 'github') {
      const url = `https://api.github.com/repos/${source.repo}/releases/latest`;
      const json = (await fetchJson(url)) as { tag_name?: string };
      const tag = json.tag_name ?? null;
      return tag ? tag.replace(/^v/, '') : null;
    }

    return null;
  }

  /**
   * Whether a registry actually carries the platform build an install on `target` would need.
   *
   * The CLIs offered here ship their real program body as npm platform packages, pulled in as
   * `optionalDependencies`. npm skips an optional dependency it cannot resolve **without
   * failing**: the install prints success, and the launcher then reports its binary missing on
   * first run. Measured 2026-08-12: npmmirror carried `@ampcode/cli` itself but only a
   * `0.0.0-placeholder` of `@ampcode/cli-linux-x64`, so installing Amp from it produced exactly
   * that — `npm install` exit 0, then "Amp native binary not installed."
   *
   * Asking the registry is deliberate rather than keeping a table of known-bad pairs: mirrors
   * sync lazily, so the answer changes on the mirror's schedule, not on our release schedule.
   *
   *   'ok'      — the needed build is there, or the package has no platform builds to need
   *   'missing' — the registry answered, and it does not have it
   *   'unknown' — we could not find out; callers must not treat this as unavailable
   */
  async probePlatformBuild(
    packageName: string,
    registryId: string,
    target: { platform: string; arch: string },
  ): Promise<PlatformBuildVerdict> {
    const base = npmRegistryUrl(registryId);
    if (!base) return 'unknown';

    const cacheKey = `${packageName}@${registryId}:${target.platform}-${target.arch}`;
    const cached = this.platformCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.verdict;

    const verdict = await this.resolvePlatformBuild(base, packageName, target);
    // Do not cache 'unknown'. It means the check did not get an answer — usually the network —
    // and freezing that for six hours would keep re-serving a non-answer long after it recovered.
    if (verdict !== 'unknown') {
      this.platformCache.set(cacheKey, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return verdict;
  }

  private async resolvePlatformBuild(
    base: string,
    packageName: string,
    target: { platform: string; arch: string },
  ): Promise<PlatformBuildVerdict> {
    let manifest: { optionalDependencies?: Record<string, string> };
    try {
      manifest = (await fetchJson(`${base}/${encodeURIComponent(packageName)}/latest`)) as {
        optionalDependencies?: Record<string, string>;
      };
    } catch (err) {
      this.logger?.debug(`[latest-version] platform probe failed for ${packageName}: ${String(err)}`);
      return 'unknown';
    }

    const optional = manifest.optionalDependencies ?? {};
    const suffix = `-${target.platform}-${target.arch}`;
    const entry = Object.entries(optional).find(([name]) => name.endsWith(suffix));
    // No per-platform build at all — pure JS, or a shape we do not recognise. Nothing to verify,
    // and claiming "missing" from an absence of evidence would withhold a working source.
    if (!entry) return 'ok';

    const [depName, spec] = entry;
    const resolved = resolveAliasSpec(depName, spec);
    if (!resolved) return 'unknown';

    try {
      await fetchJson(
        `${base}/${encodeURIComponent(resolved.name)}/${encodeURIComponent(resolved.version)}`,
      );
      return 'ok';
    } catch (err) {
      // A 404 is the answer we came for; anything else (offline, DNS, 5xx) is not an answer.
      return String(err).includes('HTTP 404') ? 'missing' : 'unknown';
    }
  }

  /**
   * Evict cached entries for a source (e.g. after a successful update).
   * For npm this drops every registry's entry: an update can change which registry is in use,
   * and a stale entry under the previous registry would resurface the pre-update version.
   */
  invalidate(source: ReleaseSource): void {
    if (source.kind === 'none') return;
    if (source.kind === 'npm') {
      const prefix = `npm:${source.package}@`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
      // Availability is re-checked too. "Check for updates" is the user's only lever here, and a
      // mirror that has since synced the platform build would otherwise stay marked unusable
      // for the rest of the TTL with nothing they could press.
      const platformPrefix = `${source.package}@`;
      for (const key of this.platformCache.keys()) {
        if (key.startsWith(platformPrefix)) this.platformCache.delete(key);
      }
      return;
    }
    if (source.kind === 'acp-registry') {
      this.cache.delete(`acp-registry:${source.agentId}`);
      // 「检查更新」是用户唯一的手柄:索引也一起作废,下一次真的去问注册表。
      this.acpRegistry = null;
      return;
    }
    if (source.kind === 'vendor-manifest') {
      this.cache.delete(`vendor-manifest:${source.manifest}`);
      return;
    }
    this.cache.delete(`github:${source.repo}`);
  }
}
