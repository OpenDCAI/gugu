import { describe, expect, it } from 'vitest'
import { firstRunRecordSchema, firstRunRunner, runFirstRun, type FirstRunDeps, type FirstRunOffer, type FirstRunRecord, type FirstRunState } from '../../../../apps/desktop/src/session/shared/extensions/first-run'
import type { ExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

/**
 * 161 10-16 (owner: our own Apps install at first start without asking): a new profile's first start puts
 * in the market's first-run set — gugu's own Apps — in the background, nobody asked, no page. Offline, a broken download,
 * only some of it in: nothing said, the rest goes in quietly at the next start until each went in once; one uninstalled
 * after it went in stays out. Someone else's App marked `firstRun` is never put in. An old profile never runs it. One rule
 * for the desktop (main) and the phone (its page): what is tried here is the runner both run.
 * Control (the parent commit c3c408365b): a first start asked one page (「都装」/「不装」) and installed nothing until answered.
 */

const GUGU = { repo: 'shuxueshuxue/gugu-apps' }
const app = (id: string, capabilities: string[] = []): ExtensionManifest =>
  ({ id, name: id.toUpperCase(), version: '1.0.0', apiVersion: 25, defaultLocale: 'en', entry: 'index.html', permissions: { capabilities, network: [] }, contributes: { tabs: [{ name: 'main', title: id }] } }) as ExtensionManifest
const offer = (id: string, firstRun = true, source = GUGU): FirstRunOffer => ({ manifest: app(id), version: '1.0.0', firstRun, source })

/** A device: its record, the market, what is here, and the one silent install. */
function device(record: FirstRunRecord) {
  const state = {
    record,
    market: [offer('office'), offer('search'), offer('radar', false)] as FirstRunOffer[],
    marketDown: false,
    here: [] as string[],
    /** Ids whose install fails (a download that broke), once each. */
    failing: new Set<string>(),
    installs: [] as string[],
    arriving: [] as FirstRunState[],
    warned: [] as string[],
    unusable: new Set<string>(),
  }
  const deps: FirstRunDeps = {
    record: async () => state.record,
    save: async (next) => void (state.record = next),
    offers: async () => {
      if (state.marketDown) throw new Error('market index.json: HTTP 503')
      return state.market
    },
    here: async () => [...state.here],
    usable: (manifest) => !state.unusable.has(manifest.id),
    install: async (id, version) => {
      state.installs.push(`${id}@${version}`)
      if (state.failing.delete(id)) throw new Error('download broke')
      state.here.push(id)
    },
    arriving: (next) => void state.arriving.push(next),
    now: () => '2026-10-16T12:00:00Z',
    warn: (message) => void state.warned.push(message),
  }
  return { state, deps }
}
/** One line per thing said to the windows: what is on its way, and whether the set is still to be done. */
const said = (states: FirstRunState[]) => states.map(({ apps, pending }) => `[${apps.map((one) => `${one.manifest.id}${one.installing ? '' : ' (waits)'}`).join(', ')}]${pending ? ' pending' : ' nothing to wait for'}`)

describe('the first-run set goes in by itself (runFirstRun)', () => {
  it('a new profile: the set the market names goes in, one after another, nobody asked — what is on its way said as it goes', async () => {
    const { state, deps } = device({ state: 'pending' })
    await runFirstRun(deps)
    // radar is not in the set; nothing in the deps can ask anyone.
    expect(state.installs).toEqual(['office@1.0.0', 'search@1.0.0'])
    expect(said(state.arriving)).toEqual(['[] pending', '[office, search] pending', '[search] pending', '[] pending', '[] nothing to wait for'])
    expect(state.record).toEqual({ state: 'done', at: '2026-10-16T12:00:00Z' })
    expect(state.warned).toEqual([])

    // The next start: nothing more to do.
    await runFirstRun(deps)
    expect(state.installs).toHaveLength(2)
  })

  it('someone else\'s App marked firstRun is never put in — judged here, by where its code is', async () => {
    const { state, deps } = device({ state: 'pending' })
    state.market = [offer('office'), offer('theirs', true, { repo: 'someone/their-apps' })]
    await runFirstRun(deps)
    expect(state.installs, '对照:同一份目录里 gugu 自己的 office 照装').toEqual(['office@1.0.0'])
    expect(state.record).toEqual({ state: 'done', at: '2026-10-16T12:00:00Z' })
  })

  it('offline (the market cannot be read): nothing said, nothing put in, the profile still new — the next start puts it in', async () => {
    const { state, deps } = device({ state: 'pending' })
    state.marketDown = true
    await runFirstRun(deps)
    expect(state.installs).toEqual([])
    expect(state.record).toEqual({ state: 'pending' })
    expect(state.warned).toHaveLength(1)
    // Said to be still to do, nothing known on its way: a window opening a file nobody opens tries again, not offers it.
    expect(said(state.arriving)).toEqual(['[] pending', '[] pending'])

    state.marketDown = false
    await runFirstRun(deps)
    expect(state.installs).toEqual(['office@1.0.0', 'search@1.0.0'])
    expect(state.record.state).toBe('done')
  })

  it('only one went in: no word about the other, which goes in quietly at the next start', async () => {
    const { state, deps } = device({ state: 'pending' })
    state.failing.add('search')
    await expect(runFirstRun(deps)).resolves.toBeUndefined()
    expect(state.here).toEqual(['office'])
    expect(state.record).toEqual({ state: 'pending', apps: ['office', 'search'], installed: ['office'] })
    // The panel learns search waits (not on its way any more): it can say so if a file of it is opened.
    expect(said(state.arriving).at(-1)).toBe('[search (waits)] pending')

    await runFirstRun(deps)
    expect(state.installs).toEqual(['office@1.0.0', 'search@1.0.0', 'search@1.0.0'])
    expect(state.record.state).toBe('done')
  })

  it('in once is done: one uninstalled since is not put back — neither after it was done, nor while the rest was pending', async () => {
    const { state, deps } = device({ state: 'pending' })
    state.failing.add('search')
    await runFirstRun(deps)
    state.here = [] // office uninstalled before the next start
    await runFirstRun(deps)
    expect(state.installs).toEqual(['office@1.0.0', 'search@1.0.0', 'search@1.0.0'])
    expect(state.record.state).toBe('done')
    state.here = []
    await runFirstRun(deps)
    expect(state.installs).toHaveLength(3)
  })

  it('an install a start cut off (here, but not whole) is put in again; one put in some other way meanwhile is not put in twice', async () => {
    const { state, deps } = device({ state: 'pending', apps: ['office', 'search'], installed: [] })
    // `here` names only Apps whose install finished: the cut-off office is not among them. search came in through its card.
    state.here = ['search']
    await runFirstRun(deps)
    expect(state.installs).toEqual(['office@1.0.0'])
    expect(state.record.state).toBe('done')
  })

  it('an install that fails because it is in meanwhile (the person installed it as it came down) counts as in', async () => {
    const { state, deps } = device({ state: 'pending' })
    deps.install = async (id) => {
      state.here.push(id)
      throw new Error(`${id} is installed here already; it is not put in again without asking`)
    }
    await runFirstRun(deps)
    expect(state.record.state).toBe('done')
    expect(state.warned).toEqual([])
  })

  it('the set is the one the market named first: an App added to it later is for new profiles; one this device cannot use is not in it', async () => {
    const { state, deps } = device({ state: 'pending' })
    state.unusable.add('search')
    state.failing.add('office')
    await runFirstRun(deps)
    expect(state.record).toEqual({ state: 'pending', apps: ['office'], installed: [] })
    state.market = [...state.market, offer('later')]
    await runFirstRun(deps)
    expect(state.installs).toEqual(['office@1.0.0', 'office@1.0.0'])
    expect(state.record.state).toBe('done')
  })

  it("the set shrank (one taken off the market's set): no window waits for it; the record looks again at the next start", async () => {
    const { state, deps } = device({ state: 'pending', apps: ['office', 'search'], installed: ['office'] })
    state.here = ['office']
    state.market = [offer('office'), offer('search', false)]
    await runFirstRun(deps)
    expect(state.installs).toEqual([])
    expect(said(state.arriving).at(-1), '复评 10-16:以前这里一直是 pending,窗口每打开一个没人能开的文件都去再试一次').toBe('[] nothing to wait for')
    expect(state.record).toEqual({ state: 'pending', apps: ['office', 'search'], installed: ['office'] })
    // Back on the market's set later: it goes in then.
    state.market = [offer('office'), offer('search')]
    await runFirstRun(deps)
    expect(state.installs).toEqual(['search@1.0.0'])
    expect(state.record.state).toBe('done')
  })

  it('an old profile (existing) and a done one: never anything', async () => {
    for (const record of [{ state: 'existing' }, { state: 'done', at: '2026-10-16T00:00:00Z' }] as FirstRunRecord[]) {
      const { state, deps } = device(record)
      await runFirstRun(deps)
      expect(state.installs).toEqual([])
      expect(state.arriving).toEqual([])
    }
  })

  it('asked again while a go runs (a file of an arriving App opened): the same go answers', async () => {
    const { state, deps } = device({ state: 'pending' })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const install = deps.install
    deps.install = async (id, version) => {
      await held
      return install(id, version)
    }
    const runner = firstRunRunner(deps)
    const first = runner.run()
    const second = runner.run()
    expect(second).toBe(first)
    release()
    await first
    expect(state.installs).toEqual(['office@1.0.0', 'search@1.0.0'])
  })
})

describe('the first-run record', () => {
  it('reads only the three states it writes', () => {
    expect(firstRunRecordSchema.parse({ state: 'done', at: '2026-10-16T12:00:00Z' })).toEqual({ state: 'done', at: '2026-10-16T12:00:00Z' })
    expect(firstRunRecordSchema.parse({ state: 'pending', apps: ['office'], installed: [] })).toEqual({ state: 'pending', apps: ['office'], installed: [] })
    expect(firstRunRecordSchema.safeParse({ state: 'declined', at: '2026-10-15T12:00:00Z' }).success).toBe(false)
    expect(firstRunRecordSchema.safeParse({ state: 'maybe' }).success).toBe(false)
  })
})
