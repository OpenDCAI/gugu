import { z } from 'zod';
import type { ExtensionManifest } from './manifest';
import type { MarketCodeSource } from './market';

/**
 * 首启默认组:新 profile 一启动,市场索引里标了 `firstRun` 的那几个 **gugu 自己的** App 在后台装上 —— 不出任何页面
 * (owner 10-16:这些是咕咕自己的 App,以前预装的时候从来不问;「为什么会有安装这一步,而不是一启动就
 * 装好了」:包里已经不带它们了,要从下载站拿,而市场索引和包都是公开文件、不要登录 ⇒ 一启动就开始,和登录并行)。
 * 桌面在 main 里跑(first-run-apps.ts),手机在它自己的页里跑(firstRunApps.ts);规矩只有这里这一份。
 *
 * - 只装 gugu 自己的(`isGuguOwnApp`):代码就在市场索引仓里的 App。别人的 App 就算在索引里标了 `firstRun` 也不装 ——
 *   这一条在客户端里判,❌ 只靠索引仓那边审 PR。
 * - 同意照预装的记:按 gugu 自己审过的(安装里 `consent: gugu`),能力照 manifest 记下,App 页照常看得到它要了什么、能停用、
 *   能卸载;给哪些 agent 是「本机所有 agent」,同没人选过的 App。都只写这台设备自己的东西,❌ 要登录。
 * - 离线、下载断了、只装上一部分:不说什么,下次启动安静地补装,直到每个都装上过一次。装上过一次就不再碰:后来卸了,不会装回来。
 */

/** The market's own repository (shuxueshuxue/gugu-apps): an App whose code is in it is gugu's own — reviewed and published by gugu. */
export const GUGU_APPS_REPO = 'shuxueshuxue/gugu-apps';

/**
 * Whether a market App is gugu's own: its code is in the market's own repository. The index's CI rebuilt the very bytes from
 * that repository's commit (and only from its default branch), so this is a fact about the code, not something the index
 * entry merely says — an App of someone else's lives in their repository.
 */
export function isGuguOwnApp(source: Pick<MarketCodeSource, 'repo'>): boolean {
  return source.repo === GUGU_APPS_REPO;
}

/**
 * This profile's record (desktop: a file in main's userData, first-run-record.ts; phone: its App store index):
 * - `existing`: the profile had Apps on record before this came in (an old profile upgraded) — never runs;
 * - `pending`: a new profile, not done yet. `apps`: the set as the market named it the first time it was read (none: not
 *   read yet); `installed`: those that went in once;
 * - `done`: every one went in once — never runs again.
 */
export const firstRunRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('existing') }),
  z.object({ state: z.literal('pending'), apps: z.array(z.string()).optional(), installed: z.array(z.string()).optional() }),
  z.object({ state: z.literal('done'), at: z.string() }),
]);

export type FirstRunRecord = z.infer<typeof firstRunRecordSchema>;

/** A market App for this device (its version for here, compatible, not deprecated), as the first-run set reads it. */
export interface FirstRunOffer {
  manifest: ExtensionManifest;
  version: string;
  firstRun: boolean;
  source: Pick<MarketCodeSource, 'repo'>;
}

/**
 * An App of the set not in yet, as a group's panel says it for a file it would open (161 10-16: 「咕咕办公正在装好,马上打开」,
 * ❌ 「没有 App 能打开 / 推荐去装」). `installing`: being fetched or put in now; false: it did not go in this time (offline,
 * a broken download) — tried again at the next start, or when someone opens a file of its.
 */
export interface FirstRunArriving {
  manifest: ExtensionManifest;
  installing: boolean;
}

/**
 * What a window knows of the set: the Apps on their way, and whether it is still to be done here (`pending`) — true also
 * when the market could not be read yet, so nobody knows which Apps they are: a file opened then is the reason to try again.
 */
export interface FirstRunState {
  apps: FirstRunArriving[];
  pending: boolean;
}

export interface FirstRunDeps {
  record(): Promise<FirstRunRecord>;
  save(record: FirstRunRecord): Promise<void>;
  /** The market's Apps for this device; throws when the market cannot be read. */
  offers(): Promise<FirstRunOffer[]>;
  /** The ids of the Apps on this device now, each one whose install finished (one that is not is put in again). */
  here(): Promise<string[]>;
  /** Whether the App does anything on this device at all. */
  usable(manifest: ExtensionManifest): boolean;
  /** Puts one in, asking nobody (gugu's own, as gugu reviewed it); throws what failed. */
  install(id: string, version: string): Promise<void>;
  /** What is on its way, and whether the set is still to be done, each time that changes. */
  arriving(state: FirstRunState): void;
  now(): string;
  warn(message: string, detail: Record<string, unknown>): void;
}

/**
 * One go at the first-run set: what is not in yet goes in, one after another (the market's staging is one at a time),
 * nobody asked. Whatever fails waits for the next go — quietly: it is said in the log only.
 */
export async function runFirstRun(deps: FirstRunDeps): Promise<void> {
  const record = await deps.record();
  if (record.state !== 'pending') return;
  // Still to be done: a window that opens a file nobody there opens meanwhile waits for this go, rather than offering it.
  deps.arriving({ apps: [], pending: true });
  let offers: FirstRunOffer[];
  try {
    offers = await deps.offers();
  } catch (error) {
    // Offline, or the download site down: nothing to say to anyone; the next go reads it again.
    deps.warn('the market could not be read; the first-run Apps go in at the next start', { error: messageOf(error) });
    deps.arriving({ apps: [], pending: true });
    return;
  }
  const own = (offer: FirstRunOffer) => offer.firstRun && isGuguOwnApp(offer.source) && deps.usable(offer.manifest);
  // The set is the one the market named the first time it was read: a list changed later is for new profiles from then on.
  const apps = record.apps ?? offers.filter(own).map((offer) => offer.manifest.id);
  const here = await deps.here();
  const installed = [...new Set([...(record.installed ?? []), ...apps.filter((id) => here.includes(id))])];
  let current: FirstRunRecord = { state: 'pending', apps, installed };
  await deps.save(current);
  // Each one still in the set as the market has it now, and still gugu's own: an App taken off the set (or no version for
  // here now) waits; one whose code moved out of gugu's repository is never put in.
  const wanted = apps.filter((id) => !installed.includes(id)).flatMap((id) => offers.filter((offer) => offer.manifest.id === id && own(offer)));
  const arriving = new Map(wanted.map((offer) => [offer.manifest.id, { manifest: offer.manifest, installing: true }]));
  deps.arriving({ apps: [...arriving.values()], pending: true });
  for (const offer of wanted) {
    const id = offer.manifest.id;
    try {
      await deps.install(id, offer.version);
      installed.push(id);
      current = { state: 'pending', apps, installed: [...installed] };
      await deps.save(current);
      arriving.delete(id);
    } catch (error) {
      // Put in some other way meanwhile (its card, the Apps page): in. Else the others still go; this one at the next go.
      if ((await deps.here()).includes(id)) {
        installed.push(id);
        current = { state: 'pending', apps, installed: [...installed] };
        await deps.save(current);
        arriving.delete(id);
      } else {
        deps.warn('a first-run App did not go in; it is put in at the next start', { id, error: messageOf(error) });
        arriving.set(id, { manifest: offer.manifest, installing: false });
      }
    }
    deps.arriving({ apps: [...arriving.values()], pending: true });
  }
  const done = apps.every((id) => installed.includes(id));
  if (done) await deps.save({ state: 'done', at: deps.now() });
  // Still to wait for only while one of them failed this go and can be tried again. One the market does not offer now (taken
  // off the set, no version for here) is not coming: the record looks again at the next start, but no window waits for it
  // (复评 10-16: the set shrank, and every file nobody here opened waited on a go that could bring nothing).
  deps.arriving({ apps: [...arriving.values()], pending: !done && arriving.size > 0 });
}

/** One go at a time: asked again while one runs (a file of an arriving App opened), the same go answers. */
export function firstRunRunner(deps: FirstRunDeps): { run(): Promise<void> } {
  let running: Promise<void> | null = null;
  return {
    run() {
      running ??= runFirstRun(deps)
        .catch((error: unknown) => deps.warn('the first-run Apps were not done this go', { error: messageOf(error) }))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
