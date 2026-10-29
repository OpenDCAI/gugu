/**
 * 桥接 ↔ CLI 版本配对的纯逻辑(#6394)。IO 在 `claude-bridge.ts`。
 *
 * 配对表是**咕咕自己的声明**:shuxueshuxue/gugu-acp 的 `compat.json`,发布成 npm 包 `@gugu-acp/compat`
 * (整张表内联在它 package.json 的 `gugu.compat`)。上游 SDK 里的 `claudeCodeVersion` 只是起点,
 * 一个 CLI 版本只有在我们自己跑过 ABC(真 CLI 驱动桥接,插消息的那一轮必须结束)之后才进 `verified`。
 *
 * 形状:每个桥接按 `cliFrom` 排好的若干发布;一个发布管 `[自己的 cliFrom, 下一个发布的 cliFrom)`,
 * 最新那个不设上限。区间互斥 ⇒ 用户的 CLI 版本只落在一个发布里。
 */
import { z } from 'zod';
import { versionLineOf } from '@gugu/session-core/deps/runtime';

const releaseSchema = z.object({
  version: z.string().min(1),
  upstreamTag: z.string().optional(),
  cliFrom: z.string().min(1),
  verified: z.array(z.object({ cli: z.string().min(1) }).passthrough()),
});

const bridgeSchema = z.object({
  package: z.string().min(1),
  cli: z.string().min(1),
  releases: z.array(releaseSchema).min(1),
});

const compatSchema = z.object({
  schema: z.literal(1),
  bridges: z.record(z.string(), bridgeSchema),
});

export type CompatRelease = z.infer<typeof releaseSchema>;
export type CompatBridge = z.infer<typeof bridgeSchema>;
export type CompatTable = z.infer<typeof compatSchema>;

/** 一份配对表连同它是哪一版 `@gugu-acp/compat`(新旧按它比,不按拿到的先后)。 */
export type VersionedCompat = { compatVersion: string; table: CompatTable };

/** 格式不对就抛 —— 一张读不懂的表不能被当成「没有更新的桥接」。 */
export function parseCompat(raw: unknown): CompatTable {
  return compatSchema.parse(raw);
}

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;

/** 从 `--version` 的输出里取第一个 x.y.z(`2.1.282 (Claude Code)` → `2.1.282`)。取不到 = null。 */
export function parseCliVersion(output: string, versionLine?: RegExp): string | null {
  // claude 自己那一行(`versionLineOf`):包装器(wcc)先打的 banner 里也有版本号,认不出才照旧取第一个。
  const m = SEMVER.exec(versionLineOf(output, versionLine) ?? output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** 只比 x.y.z 三段数字;预发布后缀不参与(配对表里只写正式版)。 */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** 两份表里取新的那份(按 `@gugu-acp/compat` 的版本号)。 */
export function newerCompat(a: VersionedCompat | null, b: VersionedCompat | null): VersionedCompat | null {
  if (!a) return b;
  if (!b) return a;
  return compareVersions(b.compatVersion, a.compatVersion) > 0 ? b : a;
}

function sortedReleases(bridge: CompatBridge): CompatRelease[] {
  return [...bridge.releases].sort((x, y) => compareVersions(x.cliFrom, y.cliFrom));
}

/** 这张表对这个桥接「知道」到哪个 CLI 版本为止:所有 cliFrom 与 verified 里最大的那个。 */
export function highestKnownCli(bridge: CompatBridge): string {
  let top = bridge.releases[0]!.cliFrom;
  for (const r of bridge.releases) {
    for (const v of [r.cliFrom, ...r.verified.map((x) => x.cli)]) {
      if (compareVersions(v, top) > 0) top = v;
    }
  }
  return top;
}

export type ReleasePick =
  | { release: CompatRelease; reason: 'in-range' }
  /** 用户的 CLI 比表里最低的 cliFrom 还旧:没有哪个发布声明过管它,取最低的那个并如实记下。 */
  | { release: CompatRelease; reason: 'below-lowest' };

export function pickRelease(bridge: CompatBridge, cliVersion: string): ReleasePick {
  const releases = sortedReleases(bridge);
  let chosen: CompatRelease | null = null;
  for (const r of releases) {
    if (compareVersions(cliVersion, r.cliFrom) >= 0) chosen = r;
  }
  return chosen ? { release: chosen, reason: 'in-range' } : { release: releases[0]!, reason: 'below-lowest' };
}

/** 上一次为哪个 CLI 版本联网查过表(没查到更新也记,免得每开一次会话就查一次)。 */
export type CompatCheck = { cli: string; at: number };

export const COMPAT_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * 要不要联网取最新的表 —— 只在「用户的 CLI 比手上这张表知道的都新」时才要(#6394 的约定:
 * 当前桥接还管得了当前 CLI 就不探测)。同一个 CLI 版本查过一次,6 小时内不再查。
 */
export function shouldRefreshCompat(input: {
  bridge: CompatBridge;
  cliVersion: string;
  lastCheck: CompatCheck | null;
  now: number;
}): boolean {
  if (compareVersions(input.cliVersion, highestKnownCli(input.bridge)) <= 0) return false;
  const last = input.lastCheck;
  if (last && last.cli === input.cliVersion && input.now - last.at < COMPAT_RECHECK_MS) return false;
  return true;
}
