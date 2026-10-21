// @vitest-environment jsdom
// @@@android-app-update 安卓壳的应用内更新(product spec)。
//
// 原生插件只搬运(取清单、下包校验、交给系统安装器),判据全在 capacitorAppUpdate.ts ——
// 所以这里把插件换成一个记账的假件,判的是**判据**:什么时候静默下、什么时候先问、
// 下好的包重开之后还在不在、哪些包该删、哪些绝不能删、状态会不会被后来的消息盖掉。
// 结构那几条(插件注册、权限、FileProvider 目录、清单地址同源)判的是原生那一侧接没接上。
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UI_EVENTS } from '../../../apps/desktop/src/lib/uiEvents'

type Stored = { version: string; sha256: string }

const native = vi.hoisted(() => ({ impl: null as null | Record<string, (...args: never[]) => unknown> }))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () =>
    new Proxy({}, { get: (_target, method: string) => (...args: never[]) => native.impl![method](...args) }),
}))

const SHA = (c: string) => c.repeat(64)

function manifest(version: string, sha256 = SHA('b'), extra: object[] = []): string {
  return JSON.stringify({
    name: 'gugu',
    version,
    platforms: [
      ...extra,
      {
        platform: 'android',
        files: [{ name: 'gugu-beta-android.apk', size: 1234, sha256, url: 'https://download.example/gugu-beta-android.apk' }],
      },
    ],
  })
}

interface FakeOptions {
  version: string
  channel?: string
  distribution?: string
  manifest?: string | Error
  metered?: boolean
  downloads?: Stored[]
  downloadError?: Error
  /** 下载在这个 promise 落定前一直「正在下」。 */
  downloadHold?: Promise<void>
}

function fakeNative(options: FakeOptions) {
  const files: Stored[] = [...(options.downloads ?? [])]
  const calls: string[] = []
  const progress: Array<(p: { percent: number }) => void> = []
  native.impl = {
    identity: async () => ({
      version: options.version,
      channel: options.channel ?? 'beta',
      distribution: options.distribution ?? 'published',
    }),
    fetchManifest: async () => {
      calls.push('fetchManifest')
      if (options.manifest instanceof Error) throw options.manifest
      return { text: options.manifest ?? manifest(options.version) }
    },
    networkMetered: async () => ({ metered: options.metered ?? false }),
    listDownloads: async () => ({ downloads: files.map((f) => ({ ...f })) }),
    deleteDownload: async (pkg: Stored) => {
      calls.push(`delete ${pkg.version}`)
      const i = files.findIndex((f) => f.version === pkg.version && f.sha256 === pkg.sha256)
      if (i >= 0) files.splice(i, 1)
    },
    download: async (target: Stored) => {
      calls.push(`download ${target.version}`)
      await options.downloadHold
      if (options.downloadError) throw options.downloadError
      files.push({ version: target.version, sha256: target.sha256 })
    },
    install: async (pkg: Stored) => {
      calls.push(`install ${pkg.version}`)
    },
    addListener: async (_event: string, listener: (p: { percent: number }) => void) => {
      progress.push(listener)
      return { remove: async () => undefined }
    },
  }
  return { files, calls, progress }
}

let statusEvents: Array<{ status: string; updateInfo: { version: string } | null; message?: string }>
const onStatus = (event: Event) => statusEvents.push((event as CustomEvent).detail)

async function load() {
  vi.resetModules()
  return import('../../../apps/desktop/src/platform/capacitorAppUpdate')
}

beforeEach(() => {
  statusEvents = []
  window.addEventListener(UI_EVENTS.updateStatus, onStatus)
})
afterEach(() => {
  window.removeEventListener(UI_EVENTS.updateStatus, onStatus)
  native.impl = null
})

describe('启动时先对本地的账 —— 「下好了、等你按」重开之后也找得回来', () => {
  it('比装着的新的只留最新那一个并答「可以装了」;装过的、过时的都删掉;清单取不到也不影响', async () => {
    const { calls, files } = fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: new Error('network error: java.net.UnknownHostException'),
      downloads: [
        { version: '0.2.47-beta.9.1', sha256: SHA('1') },
        { version: '0.2.47-beta.10.1', sha256: SHA('2') }, // 刚装上的那一版:任务完成,删
        { version: '0.2.47-beta.11.1', sha256: SHA('3') }, // 已被 12 取代
        { version: '0.2.47-beta.12.1', sha256: SHA('4') },
      ],
    })
    const update = await load()
    const state = await update.updateState()
    expect(state.status).toBe('downloaded')
    expect(state.updateInfo).toEqual({ version: '0.2.47-beta.12.1' })
    expect(files).toEqual([{ version: '0.2.47-beta.12.1', sha256: SHA('4') }])
    expect(calls.filter((c) => c.startsWith('delete')).sort()).toEqual([
      'delete 0.2.47-beta.10.1',
      'delete 0.2.47-beta.11.1',
      'delete 0.2.47-beta.9.1',
    ])
    await update.installUpdate()
    expect(calls).toContain('install 0.2.47-beta.12.1')
  })

  it('本地一个包都没有 → 没有东西可装,installUpdate 响亮拒绝', async () => {
    fakeNative({ version: '0.2.47-beta.10.1' })
    const update = await load()
    expect((await update.updateState()).status).not.toBe('downloaded')
    await expect(update.installUpdate()).rejects.toThrow(/没有下好的更新/)
  })
})

describe('走 Wi-Fi:静默下好再提示;走流量:先问再下', () => {
  it('Wi-Fi 上发现新版 → 不发「发现新版本」,直接下,下好了才出现在界面上', async () => {
    const { calls } = fakeNative({ version: '0.2.47-beta.10.1', manifest: manifest('0.2.47-beta.11.1'), metered: false })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('downloaded'))
    expect(statusEvents.map((e) => e.status)).not.toContain('available')
    expect(calls).toContain('download 0.2.47-beta.11.1')
    expect((await update.updateState()).updateInfo).toEqual({ version: '0.2.47-beta.11.1' })
  })

  it('走流量 → 先发「发现新版本」,用户点了「更新」才下', async () => {
    const { calls } = fakeNative({ version: '0.2.47-beta.10.1', manifest: manifest('0.2.47-beta.11.1'), metered: true })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('available'))
    expect(calls.some((c) => c.startsWith('download'))).toBe(false)
    await update.downloadUpdate()
    expect(calls).toContain('download 0.2.47-beta.11.1')
    expect(statusEvents.at(-1)).toMatchObject({ status: 'downloaded', updateInfo: { version: '0.2.47-beta.11.1' } })
  })

  it('用户点的下载失败 → 显式 error(横幅据此出「更新失败 + 重试」),❌ 静默退回', async () => {
    fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.11.1'),
      metered: true,
      downloadError: new Error('integrity check failed: sha256 mismatch'),
    })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('available'))
    await expect(update.downloadUpdate()).rejects.toThrow(/integrity/)
    expect(statusEvents.at(-1)).toMatchObject({ status: 'error', message: 'integrity check failed: sha256 mismatch' })
  })

  it('静默下载进行中:状态源说「正在下」并带进度,点「检查更新」答它,❌ 答「发现新版本」', async () => {
    let release!: () => void
    const { progress } = fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.11.1'),
      metered: false,
      downloadHold: new Promise<void>((resolve) => { release = resolve }),
    })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('downloading'))
    for (const listener of progress) listener({ percent: 37 })
    expect(statusEvents.at(-1)).toMatchObject({ status: 'downloading', percent: 37, updateInfo: { version: '0.2.47-beta.11.1' } })
    expect(await update.checkForUpdates()).toMatchObject({ status: 'downloading' })
    expect(statusEvents.map((e) => e.status)).not.toContain('available')
    release()
    await vi.waitFor(() => expect(statusEvents.at(-1)).toMatchObject({ status: 'downloaded' }))
  })

  it('手上有一份下好的、又静默下更新的一版失败 → 退回那一份「可以装了」,❌ 换成「发现新版本」', async () => {
    fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.12.1', SHA('c')),
      metered: false,
      downloads: [{ version: '0.2.47-beta.11.1', sha256: SHA('b') }],
      downloadError: new Error('network error: java.net.SocketTimeoutException'),
    })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('downloading'))
    await vi.waitFor(() => expect(statusEvents.at(-1)).toMatchObject({ status: 'downloaded', updateInfo: { version: '0.2.47-beta.11.1' } }))
    expect(statusEvents.map((e) => e.status)).not.toContain('available')
  })

  it('静默下载失败 → 退回「发现新版本」让用户点,❌ 弹错打扰一个什么都没按过的人', async () => {
    fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.11.1'),
      metered: false,
      downloadError: new Error('network error: java.net.SocketTimeoutException'),
    })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(statusEvents.map((e) => e.status)).toContain('available'))
    expect(statusEvents.map((e) => e.status)).not.toContain('error')
  })
})

describe('判据与桌面同一份(shared/update-policy)', () => {
  it('线上与装着的一样 → 已是最新,什么都不下', async () => {
    const { calls } = fakeNative({ version: '0.2.47-beta.10.1', manifest: manifest('0.2.47-beta.10.1') })
    const update = await load()
    const result = await update.checkForUpdates()
    expect(result).toMatchObject({ status: 'not-available', messageKey: 'about.updateUpToDate' })
    expect(calls.some((c) => c.startsWith('download'))).toBe(false)
  })

  it('线上比装着的旧(CDN 还没刷新)→ 不提示,❌ 降级', async () => {
    const { calls } = fakeNative({ version: '0.2.47-beta.11.1', manifest: manifest('0.2.47-beta.10.1') })
    const update = await load()
    expect((await update.checkForUpdates()).status).toBe('not-available')
    expect(calls.some((c) => c.startsWith('download'))).toBe(false)
  })

  it('正式线拒收预发布版(清单被误发也不提示)', async () => {
    const { calls } = fakeNative({ version: '0.2.47', channel: 'stable', manifest: manifest('0.2.48-beta.1.1') })
    const update = await load()
    expect((await update.checkForUpdates()).status).toBe('not-available')
    expect(calls.some((c) => c.startsWith('download'))).toBe(false)
  })

  it('本地构建不追线上 —— 照实说,连清单都不去取', async () => {
    const { calls } = fakeNative({ version: '0.2.47', channel: 'stable', distribution: 'local' })
    const update = await load()
    expect(await update.checkForUpdates()).toMatchObject({
      success: false,
      status: 'disabled',
      messageKey: 'about.updateDisabledLocal',
    })
    expect(calls).not.toContain('fetchManifest')
  })

  it('下好之后,「已是最新」「检查失败」都盖不掉它;检查也答「可以装了」', async () => {
    fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.10.1'),
      downloads: [{ version: '0.2.47-beta.11.1', sha256: SHA('3') }],
    })
    const update = await load()
    expect((await update.checkForUpdates()).status).toBe('downloaded')
    expect((await update.updateState()).status).toBe('downloaded')
    expect(statusEvents.map((e) => e.status)).not.toContain('not-available')
  })

  it('又出了一版并下好了 → 换成新的那个,旧的待装包删掉', async () => {
    const { files } = fakeNative({
      version: '0.2.47-beta.10.1',
      manifest: manifest('0.2.47-beta.12.1', SHA('c')),
      metered: false,
      downloads: [{ version: '0.2.47-beta.11.1', sha256: SHA('3') }],
    })
    const update = await load()
    await update.updateState()
    await vi.waitFor(() => expect(files).toEqual([{ version: '0.2.47-beta.12.1', sha256: SHA('c') }]))
    expect((await update.updateState()).updateInfo).toEqual({ version: '0.2.47-beta.12.1' })
  })
})

describe('清单形状', () => {
  it('正式线读的是发版汇总的 releases/latest.json(四个平台都在),只取安卓那一项', async () => {
    const { parseAndroidUpdateManifest } = await load()
    const text = manifest('0.2.48', SHA('d'), [
      { platform: 'mac', files: [{ name: 'gugu-0.2.48-arm64.dmg', size: 1, sha256: SHA('e'), url: 'https://x/a.dmg' }] },
      { platform: 'windows', files: [] },
    ])
    expect(parseAndroidUpdateManifest(text)).toEqual({
      version: '0.2.48',
      url: 'https://download.example/gugu-beta-android.apk',
      size: 1234,
      sha256: SHA('d'),
    })
  })

  it('形状不对一律报错,❌ 挑一个猜', async () => {
    const { parseAndroidUpdateManifest } = await load()
    const twoApks = JSON.stringify({
      version: '1.0.0',
      platforms: [{ platform: 'android', files: [
        { name: 'a.apk', size: 1, sha256: SHA('a'), url: 'https://x/a.apk' },
        { name: 'b.apk', size: 1, sha256: SHA('a'), url: 'https://x/b.apk' },
      ] }],
    })
    expect(() => parseAndroidUpdateManifest(twoApks)).toThrow(/2 android packages/)
    expect(() => parseAndroidUpdateManifest(manifest('1.0.0', 'nothex'))).toThrow(/sha256/)
    expect(() => parseAndroidUpdateManifest(JSON.stringify({ version: '1.0.0', platforms: [] }))).toThrow(/0 android entries/)
  })
})

describe('原生那一侧接上了', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  const plugin = read('apps/mobile/android/app/src/main/java/app/gugu/chat/GuguAppUpdatePlugin.java')

  it('插件注册了,名字与 TS 这一侧 registerPlugin 的一致', () => {
    expect(read('apps/mobile/android/app/src/main/java/app/gugu/chat/MainActivity.java')).toContain(
      'registerPlugin(GuguAppUpdatePlugin.class)',
    )
    expect(plugin).toContain('@CapacitorPlugin(name = "GuguAppUpdate")')
    expect(read('apps/desktop/src/platform/capacitorAppUpdate.ts')).toContain("registerPlugin<GuguAppUpdatePlugin>('GuguAppUpdate')")
  })

  it('下包目录经 FileProvider 开放给安装器 —— 两处目录名必须是同一个', () => {
    const dir = /private static final String DIR = "([^"]+)"/.exec(plugin)?.[1]
    expect(dir).toBe('app-update')
    expect(read('apps/mobile/android/app/src/main/res/xml/file_paths.xml')).toContain(`<files-path name="app_update" path="${dir}/" />`)
  })

  it('交给系统安装器要的权限、问是否走流量要的权限都声明了', () => {
    const manifestXml = read('apps/mobile/android/app/src/main/AndroidManifest.xml')
    expect(manifestXml).toContain('android.permission.REQUEST_INSTALL_PACKAGES')
    expect(manifestXml).toContain('android.permission.ACCESS_NETWORK_STATE')
  })

  it('清单地址在打包时按 tier 从 updateFeeds.json 取 —— 与桌面 feed 同一份真源', () => {
    const gradle = read('apps/mobile/android/app/build.gradle')
    expect(gradle).toContain('rootProject.file("../../desktop/electron/updateFeeds.json")')
    expect(gradle).toContain('guguIsBeta ? guguUpdateFeeds.androidBeta : guguUpdateFeeds.androidStable')
    expect(gradle).toContain('buildConfigField "String", "GUGU_UPDATE_MANIFEST_URL"')
    // Read by the one reader of the download site (DownloadSite.java), which the App market's reader shares (161 10-15) —
    // its "too large" words as they were (classifyUpdateError shows them as they are).
    expect(plugin).toContain('DownloadSite.read(BuildConfig.GUGU_UPDATE_MANIFEST_URL, MANIFEST_MAX_BYTES, "update manifest is larger than 1 MiB", null)')
  })

  it('App 市场的根也从 updateFeeds.json 取,经同一个原生读取器读;只读根下面(重定向到根外不认),大小以那一行为上限', () => {
    const gradle = read('apps/mobile/android/app/build.gradle')
    expect(gradle).toContain('def guguMarketRoot = guguUpdateFeeds.market as String')
    const store = read('apps/mobile/android/app/src/main/java/app/gugu/chat/GuguAppStorePlugin.java')
    expect(store).toContain('DownloadSite.read(BuildConfig.GUGU_MARKET_ROOT + path, maxBytes,')
    expect(store).toMatch(/is larger than " \+ maxBytes \+ " bytes", BuildConfig\.GUGU_MARKET_ROOT\);/)
    // OutOfMemoryError is no Exception: the market read answers it as a failure, not a crash.
    expect(store).toContain('} catch (Throwable error) {')
    const site = read('apps/mobile/android/app/src/main/java/app/gugu/chat/DownloadSite.java')
    // The prefix is compared on the normalized address (`%2e` decoded, `.`/`..` folded): not left to the HTTP stack to fold.
    expect(site).toContain('String landed = normalized(connection.getURL().toString());')
    expect(site).toContain('if (under != null && !landed.startsWith(under)) {')
    expect(site).toContain('return new URI(url.replaceAll("(?i)%2e", ".")).normalize().toString();')
  })
})
