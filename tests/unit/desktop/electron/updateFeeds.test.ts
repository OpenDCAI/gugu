/**
 * #2177 / #5737 更新通道契约(product spec)。
 * ① 每个 tier 只跟**自己那条**通道:正式版追正式版、Beta 追 Beta、验收包谁也不追;
 * ② 正式通道仍然拒收预发布目标(feed 被误发也不提示),Beta 通道整条都是预发布版、当然收;
 * ③ 打包配置与主进程读同一份 updateFeeds.json —— 改域名不可能只改一半。
 *
 * ③ 为什么值得钉:#5737 的洞正是「所有 tier 都被指向同一条通道」——Beta 拿正式版的包去原地换,
 * 而原地换要求新包满足正在跑那个包的 designated requirement(钉着 bundle id),必不过。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import * as updatePolicy from '../../../../apps/desktop/shared/update-policy'
import {
  isStableVersion,
  parseBuildDistribution,
  resolveUpdaterPolicy,
  shouldRejectUpdateTarget,
} from '../../../../apps/desktop/shared/update-policy'
import {
  changelogUrl,
  resolveUpdateChannel,
  updateChannelName,
  updateFeedOptions,
  updateFeedUrl,
  releaseNotesPageUrl,
  releaseNotesPlatform,
  SITE_URL,
  STABLE_UPDATE_FEED_URL
} from '../../../../apps/desktop/electron/updateFeeds'
describe('local build update identity — eligibility is decided before semver', () => {
  it('local build update ineligibility is explicit before semver comparison', () => {
    const installed = '0.2.30-beta.local.7239c7d01'
    const officialBeta = '0.2.30-beta.557.1'
    expect(semver.gt(installed, officialBeta)).toBe(true)
    expect(updatePolicy.resolveUpdaterPolicy).toBe(resolveUpdaterPolicy)
    expect(resolveUpdaterPolicy({
      isPackaged: true,
      distribution: 'local',
      channel: 'stable',
    })).toEqual({
      enabled: false,
      status: 'disabled',
      reason: 'local-build',
      messageKey: 'about.updateDisabledLocal',
    })
  })
  it('published artifacts stay eligible regardless of tier or version text', () => {
    expect(resolveUpdaterPolicy({ isPackaged: true, distribution: 'published', channel: 'stable' }))
      .toEqual({ enabled: true })
    expect(resolveUpdaterPolicy({ isPackaged: true, distribution: 'published', channel: 'beta' }))
      .toEqual({ enabled: true })
  })
  it('#5737 没有通道的包(验收)不自动更新,且「关于」页照实说', () => {
    expect(resolveUpdaterPolicy({ isPackaged: true, distribution: 'published', channel: 'none' })).toEqual({
      enabled: false,
      status: 'disabled',
      reason: 'no-channel',
      messageKey: 'about.updateDisabledNoChannel',
    })
  })
  it('missing identity defaults local while unknown identity fails loudly', () => {
    expect(parseBuildDistribution(undefined)).toBe('local')
    expect(parseBuildDistribution('published')).toBe('published')
    expect(() => parseBuildDistribution('beta')).toThrow(/GUGU_BUILD_DISTRIBUTION/)
  })
})
describe('isStableVersion — 只有无预发布段的 semver 才是更新目标', () => {
  it.each<readonly [string, readonly unknown[], boolean]>([
    ['stable versions', ['0.2.28', '1.0.0', 'v0.2.28', '0.2.28+build.5'], true],
    ['the #2177 beta build', ['0.2.28-beta.188.1'], false],
    ['other prereleases', ['1.0.0-rc.1', '0.3.0-alpha', '0.2.28-beta.188.1+meta'], false],
    ['unknown values', [undefined, null, '', '0.2', 'latest', 228], false],
  ] as const)('%s', (_label, versions, expected) => {
    for (const version of versions) expect(isStableVersion(version)).toBe(expected)
  })
})
describe('shouldRejectUpdateTarget — 判据随通道走', () => {
  it.each<readonly [string, unknown, boolean]>([
    ['stable target', { version: '0.2.28' }, false],
    ['prerelease target', { version: '0.2.28-beta.188.1' }, true],
    ['null update info', null, true],
    ['undefined update info', undefined, true],
    ['missing version', {}, true],
    ['non-string version', { version: { major: 0 } }, true],
  ] as const)('正式通道 · %s', (_label, updateInfo, expected) => {
    expect(shouldRejectUpdateTarget(updateInfo, 'stable')).toBe(expected)
  })

  it.each<readonly [string, unknown, boolean]>([
    // Beta 通道**必须**收预发布版 —— 它整条通道发的就是 `<base>-beta.<run>.<attempt>`。
    // 这一条要是反了,Beta 就永远收不到自己的更新,而且是静默的:检查更新报「已是最新」。
    ['自己的 beta 包', { version: '0.2.43-beta.700.1' }, false],
    ['同通道上的稳定版号', { version: '0.2.43' }, false],
    ['形状不对的版本号', { version: '0.2' }, true],
    ['缺 version', {}, true],
    ['null', null, true],
  ] as const)('Beta 通道 · %s', (_label, updateInfo, expected) => {
    expect(shouldRejectUpdateTarget(updateInfo, 'beta')).toBe(expected)
  })

  it('没有通道时什么都不认', () => {
    expect(shouldRejectUpdateTarget({ version: '9.9.9' }, 'none')).toBe(true)
  })
})

describe('#5737 tier → 通道 — 判据是「能不能原地换」,即 bundle id 是否相同', () => {
  it('正式版追正式版,Beta 追 Beta', () => {
    expect(resolveUpdateChannel('production')).toBe('stable')
    expect(resolveUpdateChannel('beta')).toBe('beta')
  })
  it('验收包谁也不追 —— 每个 tag 一个独立 appId,升到任何别的东西上都是换了个应用', () => {
    for (const tier of ['acceptance', 'acceptance-local', 'acceptance-staging', 'whatever']) {
      expect(resolveUpdateChannel(tier)).toBe('none')
      expect(updateFeedUrl(resolveUpdateChannel(tier))).toBeNull()
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        expect(updateChannelName(resolveUpdateChannel(tier), platform)).toBeNull()
      }
    }
  })
  it('两条通道的地址与清单文件名都不同 —— 同一个就等于又混在一起了', () => {
    const stable = updateFeedUrl('stable')
    const beta = updateFeedUrl('beta')
    expect(stable).toBeTruthy()
    expect(beta).toBeTruthy()
    expect(beta).not.toBe(stable)
    expect(beta!.endsWith('/')).toBe(true)
    expect(updateChannelName('stable', 'win32')).toBe('latest')
    expect(updateChannelName('beta', 'win32')).toBe('beta')
    expect(updateChannelName('stable', 'linux')).toBe('latest')
    expect(updateChannelName('beta', 'linux')).toBe('beta')
  })
  // #7394 Mac 换了应用标识:新标识的包读自己那份清单;原来那份只列 dmg,是留给老包走 dmg 换装的。
  it('Mac 读新标识的清单(与 electron-builder.cjs 的 tier.macChannel 同名),两条通道仍互不相同', () => {
    expect(updateChannelName('stable', 'darwin')).toBe('nextmind')
    expect(updateChannelName('beta', 'darwin')).toBe('nextmind-beta')
    const builder = readFileSync(join(process.cwd(), 'electron-builder.cjs'), 'utf8')
    expect(builder).toMatch(/macChannel: 'nextmind',/)
    expect(builder).toMatch(/macChannel: 'nextmind-beta',/)
  })
})
describe('更新源 — 打包期与运行期读同一真源', () => {
  it('每条 feed 都以 / 结尾(拼相对文件名要用)', () => {
    expect(STABLE_UPDATE_FEED_URL.endsWith('/')).toBe(true)
    expect(updateFeedUrl('stable')!.endsWith('/')).toBe(true)
    expect(updateFeedUrl('beta')!.endsWith('/')).toBe(true)
  })
  it('打包配置(electron-builder.cjs)与主进程读同一真源 → 改域名不可能只改一半', () => {
    const require_ = createRequire(import.meta.url)
    const feeds = require_('../../../../apps/desktop/electron/updateFeeds.json') as Record<string, string>
    expect(updateFeedUrl('stable')).toBe(feeds.stable)
    expect(updateFeedUrl('beta')).toBe(feeds.beta)
    // @@@5813 site = 官网帮助中心的根,更新说明从那儿取(下面单独一组测它的推导)。
    // @@@android-app-update androidStable / androidBeta = 安卓壳的更新清单,由 build.gradle 按 tier 烘进包里
    // (tests/unit/mobile/androidAppUpdate.test.ts 钉那一侧)。
    // market = App 市场在下载站上的根(market-catalog-root.ts 读它;索引仓 shuxueshuxue/gugu-apps 的 CI 往那儿同步)。
    expect(Object.keys(feeds).sort()).toEqual(['androidBeta', 'androidStable', 'beta', 'market', 'site', 'stable'])
    const builderConfig = require_('../../../../electron-builder.cjs') as { publish: { url: string; channel: string } }
    expect(builderConfig.publish.url).toBe(feeds.stable)
    expect(builderConfig.publish.channel).toBe('latest')
  })
})

// @@@5813 更新说明的家搬到官网之后,地址不再随更新通道走,而是随**运行平台**走:
// 站上每个端一条自己的版本线(owner:「本来应该是 不同端不同的发布版本来着」)。
describe('更新说明 — 按端取,地址与页面同源推导', () => {
  it('四个端各映射到自己那一页', () => {
    expect(releaseNotesPlatform('darwin')).toBe('macos')
    expect(releaseNotesPlatform('win32')).toBe('windows')
    expect(releaseNotesPlatform('linux')).toBe('linux')
    expect(releaseNotesPlatform('android')).toBe('android')
  })

  it('认不出的平台返回 null —— ❌ 不猜一个端顶上', () => {
    // 猜错的后果是给用户看**别的端**的更新说明,比什么都不显示更糟。
    expect(releaseNotesPlatform('aix')).toBeNull()
    expect(releaseNotesPageUrl('aix')).toBeNull()
    expect(changelogUrl('aix')).toBeNull()
  })

  it('站点根以 / 结尾 —— 少了它 new URL 会把最后一段吃掉', () => {
    // 'https://x/a' + 'b' = 'https://x/b'。这类拼接错得很安静,所以钉一下。
    expect(SITE_URL.endsWith('/')).toBe(true)
  })

  it('feed 就是页面地址加一个文件名 —— 站点改结构时两个地址一起动', () => {
    const page = releaseNotesPageUrl('darwin')!
    expect(page.endsWith('/')).toBe(true)
    expect(changelogUrl('darwin')).toBe(`${page}changelog.json`)
  })

  it('两个地址都落在官网那一格下,不在下载站', () => {
    // 内容的家是官网帮助中心;下载站只发包。
    const require_ = createRequire(import.meta.url)
    const feeds = require_('../../../../apps/desktop/electron/updateFeeds.json') as Record<string, string>
    expect(SITE_URL).toBe(feeds.site)
    expect(changelogUrl('win32')!.startsWith(feeds.site)).toBe(true)
    expect(changelogUrl('win32')!.includes('download.')).toBe(false)
  })
})

// 状态不往回退(@@@5837),但「又在下更新的一版」要改写「下好了」:electron-updater 开始下新包时
// 就清掉了 pending 里那一份,旧的已经装不了;按下「重启更新」后宿主先去下 feed 上更新的一版也走这条。
describe('updateStateAdvances', () => {
  it.each([
    ['downloaded', 'downloading', true],
    ['downloaded', 'downloaded', true],
    ['downloaded', 'available', false],
    ['downloaded', 'not-available', false],
    ['downloaded', 'error', false],
    ['downloaded-manual', 'downloading', true],
    ['idle', 'downloading', true],
  ] as const)('%s → %s: %s', (current, next, expected) => {
    expect(updatePolicy.updateStateAdvances(current, next)).toBe(expected)
  })
})

// 10-09 owner 的 Chole 64.1→65.1:块表比对算出只要下 7%,却抛「Content-Type "multipart/byteranges" is
// expected」整包重下 198 MB。下载站(阿里云 OSS + CDN)多段 Range 只回第一段。判据交给 electron-updater
// 自己的 createClient:同一份配置在它手里得出的 provider 必须是一段一个请求。
describe('setFeedURL 的 provider 配置 —— 差分下载一段一个请求', () => {
  const require = createRequire(import.meta.url)
  const { createClient } = require('electron-updater/out/providerFactory') as {
    createClient: (data: unknown, updater: unknown, runtimeOptions: unknown) => { isUseMultipleRangeRequest: boolean }
  }
  const runtime = { isUseMultipleRangeRequest: true, platform: 'darwin', executor: {} }

  it.each(['stable', 'beta'] as const)('%s:electron-updater 据它建出的 provider 不发多段请求', (channel) => {
    const options = updateFeedOptions(channel, 'darwin')!
    expect(options).toMatchObject({ provider: 'generic', url: updateFeedUrl(channel), channel: updateChannelName(channel, 'darwin') })
    expect(createClient(options, {}, runtime).isUseMultipleRangeRequest).toBe(false)
  })

  it('阴控:不带这一项(原来那份配置)时,上游对我们的域名默认发多段请求', () => {
    const before: Record<string, unknown> = { ...updateFeedOptions('beta', 'darwin')! }
    delete before.useMultipleRangeRequest
    expect(createClient(before, {}, runtime).isUseMultipleRangeRequest).toBe(true)
  })

  it('没有通道就没有配置', () => {
    expect(updateFeedOptions('none', 'darwin')).toBeNull()
  })
})

