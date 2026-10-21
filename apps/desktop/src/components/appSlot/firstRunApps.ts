import { makeAutoObservable, when } from 'mobx'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { events, rpc } from '../../session/renderer/lib/ipc'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { firstRunRunner, type FirstRunArriving, type FirstRunDeps, type FirstRunState } from '../../session/shared/extensions/first-run'
import { firstRunArrivingChannel } from '../../session/shared/extensions/marketEvents'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { appsHere } from './appsHere'
import { phoneApps } from './phoneApps'

const log = rendererLogger('app-slot/first-run')

/**
 * 首启默认组在这一页里(规矩在 @shared/extensions/first-run.ts):一启动就开始(main.tsx),❌ 等登录,❌ 出任何页面。
 * - 桌面:装在 main(first-run-apps.ts),这里只记着「还在路上的有哪些」—— 群面板对它们会开的文件说「正在装好」,装上当场打开。
 * - 手机:手机没有 main,装在这一页里,经它自己的 App store(phoneApps.ts),同一个 runner、同一套规矩。
 */
class FirstRunArrivals {
  apps: FirstRunArriving[] = []
  /** The set is still to be done on this device (the market maybe not read yet). */
  pending = false
  constructor() {
    makeAutoObservable(this)
  }
  set(state: FirstRunState) {
    this.apps = state.apps
    this.pending = state.pending
  }
}

export const firstRunArrivals = new FirstRunArrivals()

/** Unwraps an answer of the phone's store, saying what failed. */
async function answered<T>(call: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const result = await call
  if (!result.success) throw new Error(result.error || 'no answer')
  return result.data as T
}

/** The phone's way of doing each step: its App store, its market reader. */
function phoneDeps(): FirstRunDeps {
  const here = appsHere!
  return {
    record: () => answered(phoneApps.firstRun.get()),
    save: async (record) => void (await answered(phoneApps.firstRun.set(record))),
    offers: async () =>
      (await phoneApps.market.entries())
        .filter((entry) => entry.compat === null && !entry.deprecated)
        .map((entry) => ({ manifest: entry.manifest, version: entry.version, firstRun: entry.firstRun, source: entry.source })),
    // The phone's index points at an App only once its files are whole (phoneApps.ts `store`).
    here: async () => {
      await phoneApps.ready()
      await when(() => installedExtensionsStore.isLoaded)
      return installedExtensionsStore.manifests.map((manifest) => manifest.id)
    },
    // An App that asks only for what this phone cannot give does nothing here (agents' tools): not put in.
    usable: (manifest: ExtensionManifest) => {
      const asks = manifest.permissions?.capabilities ?? []
      return here.runs(manifest) && (asks.length === 0 || (here.grantable(manifest).permissions?.capabilities ?? []).length > 0)
    },
    install: async (id, version) => {
      const done = await answered(phoneApps.installFromMarket({ ref: { extensionId: id, version }, consent: { kind: 'gugu' } }))
      if (!done.installed) throw new Error(`${id}@${version} did not go in (${done.outcome})`)
      log.info({ id, version }, 'first-run: in')
    },
    arriving: (state) => firstRunArrivals.set(state),
    now: () => new Date().toISOString(),
    warn: (message, detail) => log.warn(detail, `first-run: ${message}`),
  }
}

let phoneRunner: ReturnType<typeof firstRunRunner> | null = null
let started = false

/** Once a page load, at its very start: the desktop listens to main, the phone runs the set itself. */
export function startFirstRunApps(): void {
  if (started) return
  started = true
  if (platform.kind === 'electron') {
    events.on(firstRunArrivingChannel, (state) => firstRunArrivals.set(state))
    void rpc.extensions.firstRunArriving().then(
      (answer) => answer.success && firstRunArrivals.set(answer.data),
      (error: unknown) => log.warn({ error: error instanceof Error ? error.message : String(error) }, 'what the first-run set has on its way could not be read'),
    )
    return
  }
  if (platform.kind === 'capacitor' && appsHere) {
    phoneRunner = firstRunRunner(phoneDeps())
    void phoneRunner.run()
  }
}

/** Another go at what did not go in (a file of it was opened): answered once that go is over; what is left is in `firstRunArrivals`. */
export async function retryFirstRun(): Promise<void> {
  if (platform.kind === 'electron') {
    const answer = await rpc.extensions.retryFirstRun()
    if (!answer.success) log.warn({ error: answer.error }, 'the first-run set was not tried again')
    return
  }
  await phoneRunner?.run()
}
