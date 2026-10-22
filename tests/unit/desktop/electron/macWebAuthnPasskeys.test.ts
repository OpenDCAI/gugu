/**
 * 内置浏览器的 Touch ID 通行密钥。契约:
 *  - 只认包里嵌着的描述文件:读出本包的应用 ID(`<团队>.<标识>`),钥匙串组 = 它 + `.webauthn`;读不出就不开;
 *  - 运行期推出的钥匙串组 = 打包期写进主程序 `keychain-access-groups` 的那一项(对不上,系统第一次用就拒);
 *  - 同一网站存着多把时让人选:选中回凭据 ID,取消 / 关掉 / 越界一律 null;
 *  - 接了选账号事件就恰好回调一次:发起的那页看不见就不问、直接按取消回;对话框或文案出错也按取消回。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseWebAuthnAccount,
  createSelectAccountHandler,
  webAuthnAccountLabel,
  webAuthnKeychainGroup,
} from '../../../../apps/desktop/electron/macWebAuthn'

// 描述文件 = CMS 签名包着一段 plist:前后是二进制,中间那段 XML 原样可见(主进程按 latin1 读)。
const profileText = (appId: string) =>
  '0\u0082\u0010\u0006\t*\u0086H\u0086÷\r\u0001\u0007\u0002' +
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
  <key>AppIDName</key><string>Gugu</string>
  <key>Entitlements</key><dict>
    <key>com.apple.application-identifier</key>
    <string>${appId}</string>
    <key>keychain-access-groups</key><array><string>ABCDE12345.*</string></array>
    <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
  </dict></dict></plist>` +
  ' \u0082\u0003ÿ\u0000'

describe('钥匙串组只从嵌着的描述文件来', () => {
  it('应用 ID + .webauthn', () => {
    expect(webAuthnKeychainGroup(profileText('ABCDE12345.nextmind.gugu'))).toBe('ABCDE12345.nextmind.gugu.webauthn')
    expect(webAuthnKeychainGroup(profileText('ABCDE12345.nextmind.gugu.beta'))).toBe('ABCDE12345.nextmind.gugu.beta.webauthn')
  })
  it('没有描述文件、没有这个键、应用 ID 形状不对 → null(不开,❌ 猜一个)', () => {
    expect(webAuthnKeychainGroup(null)).toBeNull()
    expect(webAuthnKeychainGroup('<plist><dict></dict></plist>')).toBeNull()
    expect(webAuthnKeychainGroup(profileText('nextmind.gugu'))).toBeNull()
  })
  it('通配的应用 ID(团队通用描述文件)→ null:它没点名这个应用,推出的组系统不认', () => {
    expect(webAuthnKeychainGroup(profileText('ABCDE12345.*'))).toBeNull()
    expect(webAuthnKeychainGroup(profileText('ABCDE12345.nextmind.*'))).toBeNull()
  })
})

describe('运行期推出的组 = 打包期写进主程序权限的那一项', () => {
  const require_ = createRequire(import.meta.url)
  const builderFile = path.resolve(__dirname, '../../../../electron-builder.cjs')
  const dirs: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it.each([
    ['production', 'ABCDE12345.nextmind.gugu'],
    ['beta', 'ABCDE12345.nextmind.gugu.beta'],
  ])('%s', (tier, appId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-webauthn-'))
    dirs.push(dir)
    const profile = path.join(dir, 'gugu.provisionprofile')
    fs.writeFileSync(profile, profileText(appId), 'latin1')
    for (const [k, v] of Object.entries({
      GUGU_TIER: tier,
      GUGU_BUILD_DISTRIBUTION: 'published',
      GUGU_MAC_PROVISIONING_PROFILE: profile,
      CSC_LINK: 'fake',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
      APPLE_API_KEY: '/tmp/fake.p8',
      APPLE_API_KEY_ID: 'K',
      APPLE_API_ISSUER: 'I',
      APPLE_TEAM_ID: 'ABCDE12345',
    })) vi.stubEnv(k, v)
    delete require_.cache[builderFile]
    const config = require_(builderFile) as { mac: { entitlements: string } }
    delete require_.cache[builderFile]
    dirs.push(path.dirname(config.mac.entitlements))

    const entitlements = fs.readFileSync(config.mac.entitlements, 'utf8')
    const group = webAuthnKeychainGroup(fs.readFileSync(profile, 'latin1'))
    expect(group).toBe(`${appId}.webauthn`)
    expect(entitlements).toContain(`<string>${group}</string>`)
  })
})

describe('同一网站存着多把:让人选一把', () => {
  const copy = { message: '用哪个账号登录 {site}?', detail: '存着 {site} 的多把通行密钥。', cancel: '取消' }
  const accounts = [
    { credentialId: 'cred-a', name: 'a@gmail.com', displayName: 'A' },
    { credentialId: 'cred-b', name: 'b@gmail.com' },
  ]

  it('按钮 = 每个账号一颗 + 取消在最后;网站名替换进标题与说明', async () => {
    const ask = vi.fn(async () => 1)
    expect(await chooseWebAuthnAccount('accounts.google.com', accounts, copy, ask)).toBe('cred-b')
    expect(ask).toHaveBeenCalledWith({
      message: '用哪个账号登录 accounts.google.com?',
      detail: '存着 accounts.google.com 的多把通行密钥。',
      buttons: ['A(a@gmail.com)', 'b@gmail.com', '取消'],
      cancelId: 2,
    })
  })

  it('点取消、关掉对话框(-1)、越界 → null', async () => {
    for (const response of [2, -1, 9]) {
      expect(await chooseWebAuthnAccount('x.com', accounts, copy, async () => response)).toBeNull()
    }
  })

  it('没有账号 → null,不弹框', async () => {
    const ask = vi.fn(async () => 0)
    expect(await chooseWebAuthnAccount('x.com', [], copy, ask)).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('账号一行怎么写:名字优先,其次显示名,都没有用凭据 ID 前几位', () => {
    expect(webAuthnAccountLabel({ credentialId: 'abcdefghijkl', name: 'n@x.com' })).toBe('n@x.com')
    expect(webAuthnAccountLabel({ credentialId: 'abcdefghijkl', displayName: 'Nick' })).toBe('Nick')
    expect(webAuthnAccountLabel({ credentialId: 'abcdefghijkl', name: 'n', displayName: 'n' })).toBe('n')
    expect(webAuthnAccountLabel({ credentialId: 'abcdefghijkl' })).toBe('abcdefgh…')
  })
})

describe('选账号事件:恰好回调一次', () => {
  const copy = { message: '用哪个账号登录 {site}?', detail: '', cancel: '取消' }
  const details = (frame: string | null) => ({
    relyingPartyId: 'accounts.google.com',
    accounts: [{ credentialId: 'cred-a', name: 'a@gmail.com' }, { credentialId: 'cred-b', name: 'b@gmail.com' }],
    frame,
  })
  // 回调发生后再等一拍,确认不会有第二次。
  const run = async (deps: Partial<Parameters<typeof createSelectAccountHandler<string, string>>[0]>, frame: string | null = 'frame') => {
    const warn = vi.fn()
    const callback = vi.fn()
    const handle = createSelectAccountHandler<string, string>({
      parentFor: () => 'window',
      copy: () => copy,
      ask: async () => 0,
      warn,
      ...deps,
    })
    handle(details(frame), callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(callback).toHaveBeenCalledTimes(1)
    return { picked: callback.mock.calls[0][0] as string | null, warn }
  }

  it('选中 → 回那把的凭据 ID;对话框挂在发起那页所在的窗上', async () => {
    const ask = vi.fn(async () => 1)
    const parentFor = vi.fn(() => 'window-of-page')
    expect((await run({ ask, parentFor })).picked).toBe('cred-b')
    expect(parentFor).toHaveBeenCalledWith('frame')
    expect(ask).toHaveBeenCalledWith('window-of-page', expect.objectContaining({ buttons: ['a@gmail.com', 'b@gmail.com', '取消'] }))
  })

  it('点取消 → null', async () => {
    expect((await run({ ask: async () => 2 })).picked).toBeNull()
  })

  it('发起那页看不见(停放 / 窗收起 / 网页已走)→ 不问,直接 null', async () => {
    const ask = vi.fn(async () => 0)
    const { picked, warn } = await run({ ask, parentFor: () => null })
    expect(picked).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('没有发起的框架 → 同样不问', async () => {
    const ask = vi.fn(async () => 0)
    expect((await run({ ask, parentFor: (frame) => (frame ? 'window' : null) }, null)).picked).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })

  it('对话框出错 / 取文案出错 / 找窗出错 → null,记一笔', async () => {
    for (const deps of [
      { ask: async () => { throw new Error('dialog failed') } },
      { copy: () => { throw new Error('catalog failed') } },
      { parentFor: () => { throw new Error('lookup failed') } },
    ]) {
      const { picked, warn } = await run(deps)
      expect(picked).toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error))
    }
  })
})
