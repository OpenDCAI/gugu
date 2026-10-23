/**
 * #7394 Mac 换应用标识(com.gugu.app → nextmind.gugu)。契约:
 *  - 只换 Mac:顶层 appId 与 Windows / Linux 的清单不动(NSIS 的 GUID 与 AUMID 都从顶层 appId 推);
 *  - 新标识的 Mac 包住进自己那份清单(nextmind-mac.yml / nextmind-beta-mac.yml),打包期与运行期同名;
 *  - 要发布的 Developer ID 包必须嵌描述文件,受限权限只给主程序,辅助进程那份不带;
 *  - CD 的出厂门按同一个 Mac 标识查产物。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { updateChannelName, resolveUpdateChannel } from '../../../apps/desktop/electron/updateFeeds'

const repoRoot = path.resolve(__dirname, '../../..')
const require_ = createRequire(import.meta.url)

type Publish = { provider: string; url: string; channel: string }
type BuilderConfig = {
  appId: string
  publish: Publish
  mac: { appId?: string; publish?: Publish; entitlements?: string; entitlementsInherit?: string; provisioningProfile?: string }
}

// electron-builder.cjs 在 require 时按环境定型,换环境必须清掉 Node 的模块缓存重新求值。
function loadBuilderConfig(env: Record<string, string>): BuilderConfig {
  const file = path.join(repoRoot, 'electron-builder.cjs')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  delete require_.cache[file]
  try {
    return require_(file) as BuilderConfig
  } finally {
    delete require_.cache[file]
  }
}

// Developer ID 签名档的全套环境(值是假的:配置期只看在不在,真签名在 CI 上)。
const SIGNED = {
  CSC_LINK: 'fake-p12-base64',
  APPLE_API_KEY: '/tmp/fake.p8',
  APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER: 'issuer',
  APPLE_TEAM_ID: 'ABCDE12345',
  CSC_IDENTITY_AUTO_DISCOVERY: 'true',
}

const tmpDirs: string[] = []
function fakeProfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-profile-7394-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'gugu.provisionprofile')
  fs.writeFileSync(file, 'not parsed at config time')
  return file
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('#7394 只换 Mac 的标识与清单', () => {
  test.each([
    ['production', 'com.gugu.app', 'nextmind.gugu', 'latest', 'nextmind'],
    ['beta', 'com.gugu.app.beta', 'nextmind.gugu.beta', 'beta', 'nextmind-beta'],
  ])('%s:顶层仍是 %s(Windows / Linux),Mac 是 %s', (tier, appId, macAppId, channel, macChannel) => {
    const config = loadBuilderConfig({ GUGU_TIER: tier })
    expect(config.appId).toBe(appId)
    expect(config.publish.channel).toBe(channel)
    expect(config.mac.appId).toBe(macAppId)
    expect(config.mac.publish).toEqual({ provider: 'generic', url: config.publish.url, channel: macChannel })
  })

  test('验收包没有本团队注册的 Mac 标识,也没有通道:沿用顶层', () => {
    const config = loadBuilderConfig({ GUGU_TIER: 'acceptance-local' })
    expect(config.mac.appId).toBeUndefined()
    expect(config.mac.publish).toBeUndefined()
  })

  test('打包期写出的清单名 = 运行期 Mac 去读的清单名(否则新包永远查不到更新)', () => {
    for (const tier of ['production', 'beta']) {
      const config = loadBuilderConfig({ GUGU_TIER: tier })
      expect(updateChannelName(resolveUpdateChannel(tier), 'darwin')).toBe(config.mac.publish!.channel)
      // Windows / Linux 读的仍是顶层那份。
      expect(updateChannelName(resolveUpdateChannel(tier), 'win32')).toBe(config.publish.channel)
    }
  })
})

describe('#7394 描述文件与受限权限', () => {
  test('要发布的 Developer ID 包缺描述文件 → 拒绝构建(包能跑,但通行密钥悄悄没了)', () => {
    expect(() =>
      loadBuilderConfig({ ...SIGNED, GUGU_TIER: 'production', GUGU_BUILD_DISTRIBUTION: 'published' })
    ).toThrow(/没有描述文件/)
    // 阴控:本地出包(不发布)不强求,开发机照样打得出签名包。
    expect(() => loadBuilderConfig({ ...SIGNED, GUGU_TIER: 'production', GUGU_BUILD_DISTRIBUTION: 'local' })).not.toThrow()
  })

  test('有描述文件却没有 Developer ID 证书 / tier 没有 Mac 标识 / 文件不存在 → 拒绝', () => {
    const profile = fakeProfile()
    expect(() => loadBuilderConfig({ GUGU_TIER: 'production', GUGU_MAC_PROVISIONING_PROFILE: profile })).toThrow(/ad-hoc/)
    expect(() =>
      loadBuilderConfig({ ...SIGNED, GUGU_TIER: 'acceptance-local', GUGU_MAC_PROVISIONING_PROFILE: profile })
    ).toThrow(/没有本团队注册的 Mac 标识/)
    expect(() =>
      loadBuilderConfig({ ...SIGNED, GUGU_TIER: 'production', GUGU_MAC_PROVISIONING_PROFILE: `${profile}.missing` })
    ).toThrow(/不存在/)
  })

  test.each([
    ['production', 'ABCDE12345.nextmind.gugu'],
    ['beta', 'ABCDE12345.nextmind.gugu.beta'],
  ])('%s:嵌描述文件;受限权限只进主程序那份,辅助进程那份不带', (tier, appIdentifier) => {
    const profile = fakeProfile()
    const config = loadBuilderConfig({
      ...SIGNED,
      GUGU_TIER: tier,
      GUGU_BUILD_DISTRIBUTION: 'published',
      GUGU_MAC_PROVISIONING_PROFILE: profile,
    })
    expect(config.mac.provisioningProfile).toBe(profile)

    const main = fs.readFileSync(config.mac.entitlements!, 'utf8')
    tmpDirs.push(path.dirname(config.mac.entitlements!))
    expect(main).toContain(`<key>com.apple.application-identifier</key>\n    <string>${appIdentifier}</string>`)
    expect(main).toContain('<key>com.apple.developer.team-identifier</key>\n    <string>ABCDE12345</string>')
    expect(main).toMatch(new RegExp(`<key>keychain-access-groups</key>\\s*<array>\\s*<string>${appIdentifier.replace(/\./g, '\\.')}</string>`))
    // Touch ID 通行密钥专用的那一组,与运行期 macWebAuthn.ts 从描述文件推出的同名。
    expect(main).toContain(`<string>${appIdentifier}.webauthn</string>`)
    // 公共的那几条(JIT、麦克风……)一条不少。
    expect(main).toContain('<key>com.apple.security.cs.allow-jit</key>')
    expect(main).toContain('<key>com.apple.security.device.audio-input</key>')

    const inherit = fs.readFileSync(config.mac.entitlementsInherit!, 'utf8')
    expect(config.mac.entitlementsInherit).toBe(path.join(repoRoot, 'sign', 'entitlements.mac.plist'))
    expect(inherit).not.toMatch(/application-identifier|team-identifier|keychain-access-groups/)
  })

  test('没有描述文件时主程序就用公共那份(本地签名包、ad-hoc 包与改动前一致)', () => {
    const config = loadBuilderConfig({ ...SIGNED, GUGU_TIER: 'production' })
    expect(config.mac.provisioningProfile).toBeUndefined()
    expect(config.mac.entitlements).toBe(path.join(repoRoot, 'sign', 'entitlements.mac.plist'))
  })
})
