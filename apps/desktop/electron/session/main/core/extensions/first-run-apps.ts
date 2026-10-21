import { app } from 'electron';
import { firstRunRunner, type FirstRunDeps, type FirstRunState } from '@shared/extensions/first-run';
import { firstRunArrivingChannel } from '@shared/extensions/marketEvents';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { extensionsService } from './extensions-root';
import { noteFirstRunProfile, readFirstRunRecord, writeFirstRunRecord } from './first-run-record';

/**
 * 首启默认组在这台电脑上(规矩在 @shared/extensions/first-run.ts):main 一起来就开始(embedded-boot.ts),❌ 等登录、
 * ❌ 等窗口 —— 市场索引和包都是下载站上的公开文件,装上写的也都是这台电脑自己的东西。咕咕 server 走同一个 boot,同样装上
 * (以前预装时 server 包里也带着它们;server 在一个账号连上来时才为它起宿主,所以是「账号连上就装」)。界面只看「还在路上的有哪些」
 * (群面板说「正在装好」),问一次、听变化。
 */

let state: FirstRunState = { apps: [], pending: false };

function deviceDeps(): FirstRunDeps {
  const userData = app.getPath('userData');
  return {
    record: async () => readFirstRunRecord(userData),
    save: async (record) => writeFirstRunRecord(userData, record),
    offers: async () =>
      (await (await import('./market-catalog-root')).cloudExtensionMarket().offers()).map((entry) => ({
        manifest: entry.manifest,
        version: entry.version,
        firstRun: entry.firstRun,
        source: entry.source,
      })),
    // An App whose files landed but whose record did not (the start ended in between) is not whole: put in again.
    here: async () => {
      const service = extensionsService();
      const origins = service.origins();
      return service
        .list()
        .extensions.map((entry) => entry.manifest.id)
        .filter((id) => origins[id] !== undefined);
    },
    usable: () => true,
    install: async (id, version) => {
      const { installExtensionFromMarket } = await import('./extension-market-install');
      const outcome = await installExtensionFromMarket({ ref: { extensionId: id, version }, consent: { kind: 'gugu' } });
      if (!outcome.installed) throw new Error(`${id}@${version} did not go in (${outcome.outcome})`);
      log.info('first-run: in', { id, version });
    },
    arriving: (next) => {
      state = next;
      events.emit(firstRunArrivingChannel, next);
    },
    now: () => new Date().toISOString(),
    warn: (message, detail) => log.warn(`first-run: ${message}`, detail),
  };
}

let runner: ReturnType<typeof firstRunRunner> | null = null;

/** A go at the first-run set: at the start of every start, and again when a file of an App still on its way is opened. */
export function runFirstRunApps(): Promise<void> {
  runner ??= firstRunRunner(deviceDeps());
  return runner.run();
}

/** The Apps of the set on their way now, and whether the set is still to be done (neither, for a profile that is not new). */
export const firstRunArriving = (): FirstRunState => state;

/**
 * First-run at boot, for the hosts it belongs to: the desktop and 咕咕 server — both boot with `browserFeatures`. The web build's
 * headless host (session-host-entry.ts) reads the desktop's own profile (electron-shim's desktop-pointer), so first-run there
 * is the desktop's: it neither notes the profile nor starts a go (复评 10-16: it used to start one, on the desktop's record).
 */
export function firstRunAtBoot(
  browserFeatures: boolean,
  steps: { note: (userData: string) => unknown; start: () => Promise<void> } = { note: noteFirstRunProfile, start: runFirstRunApps }
) {
  return {
    /** The very first thing in a boot, before anything makes the Apps' folder: whether this profile is a new one. */
    noteProfile(userData: string): void {
      if (!browserFeatures) return;
      try {
        steps.note(userData);
      } catch (error) {
        log.warn('first-run: could not note whether this profile is new; no first-run Apps this start', { error: String(error) });
      }
    },
    /** Once this start's Apps are up: the set's go, in the background (the boot does not wait for it). */
    start(): void {
      if (!browserFeatures) return;
      void steps.start().catch((error: unknown) => log.warn('first-run: could not start', { error: String(error) }));
    },
  };
}
