/**
 * #663 mac dmg 半自动更新路径。
 * 契约(#5576 起两条判据):feed 无 zip → 启用(Squirrel 无包可下);feed 有 zip 但**本地包不是
 * Developer ID 签名** → 也启用(ad-hoc 老包的 designated requirement 绑死 cdhash,Squirrel 必不过)。
 * 其余情况交原生 Squirrel。按运行架构精确选 dmg,找不到 fail loud;下载做 sha512(base64) 校验,
 * 失配删残件报错;支持一次 3xx 重定向(CDN)。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadDmg,
  parseCodesignAuthority,
  pickMacDmgFile,
  shouldUseDmgPath
} from '../../../../apps/desktop/electron/macDmgUpdater'

describe('shouldUseDmgPath — 两条判据各挡一种静默失败', () => {
  const dmgOnly = [{ url: 'gugu-1.0-x64.dmg' }, { url: 'gugu-1.0-arm64.dmg' }]
  const withZip = [{ url: 'gugu-1.0-arm64.zip' }, { url: 'gugu-1.0-arm64.dmg' }]

  it('dmg-only feed → true,签名与否都一样(Squirrel 无包可下)', () => {
    expect(shouldUseDmgPath(dmgOnly, 'developer-id')).toBe(true)
    expect(shouldUseDmgPath(dmgOnly, 'other')).toBe(true)
  })
  it('feed 带 zip + 本地 Developer ID 签名 → false(走原生 Squirrel)', () => {
    expect(shouldUseDmgPath(withZip, 'developer-id')).toBe(false)
  })
  it('feed 带 zip 但本地是 ad-hoc 老包 → 仍然 true —— 这条是 #5576 的要害', () => {
    // 判据若只看 feed 有没有 zip,这些用户会被切到 Squirrel,DR 校验必不过且不报错。
    expect(shouldUseDmgPath(withZip, 'other')).toBe(true)
  })
  it('空/缺 files → false(交原生路径报它自己的错)', () => {
    expect(shouldUseDmgPath(undefined, 'developer-id')).toBe(false)
    expect(shouldUseDmgPath([], 'other')).toBe(false)
  })
})

describe('parseCodesignAuthority — 判本地包的签名身份', () => {
  // 两段都是 2026-09-13 在真包上实测到的 codesign -dv --verbose=2 输出(写在 stderr)。
  it('Developer ID 包 → developer-id', () => {
    const out = [
      'Identifier=com.gugu.app',
      'CodeDirectory v=20500 size=440 flags=0x10000(runtime) hashes=3+7 location=embedded',
      'Authority=Developer ID Application: Example Developer (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'TeamIdentifier=ABCDE12345',
    ].join('\n')
    expect(parseCodesignAuthority(out)).toBe('developer-id')
  })
  it('ad-hoc 包只有 Signature=adhoc、没有任何 Authority 行 → other', () => {
    const out = ['Identifier=adhoc-bin', 'CodeDirectory v=20400 size=502', 'Signature=adhoc'].join('\n')
    expect(parseCodesignAuthority(out)).toBe('other')
  })
  it('未签名 / 读不出 → other(保守回落 dmg 路径,绝不赌 Squirrel)', () => {
    expect(parseCodesignAuthority('')).toBe('other')
    expect(parseCodesignAuthority('code object is not signed at all')).toBe('other')
  })
  it('Developer ID **Installer**(另一种证书)不算 → other', () => {
    expect(parseCodesignAuthority('Authority=Developer ID Installer: Example Developer (ABCDE12345)')).toBe('other')
  })
})

describe('pickMacDmgFile — 按架构精确匹配', () => {
  const files = [{ url: 'gugu-0.2.16-x64.dmg' }, { url: 'gugu-0.2.16-arm64.dmg' }]
  it('arm64 → -arm64.dmg', () => {
    expect(pickMacDmgFile(files, 'arm64').url).toBe('gugu-0.2.16-arm64.dmg')
  })
  it('x64 → -x64.dmg', () => {
    expect(pickMacDmgFile(files, 'x64').url).toBe('gugu-0.2.16-x64.dmg')
  })
  it('架构缺失 → throw(fail loud,不乱下)', () => {
    expect(() => pickMacDmgFile([{ url: 'gugu-0.2.16-x64.dmg' }], 'arm64')).toThrow(/arm64/)
  })
})

describe('downloadDmg — 真 HTTP 下载 + sha512 校验 + 重定向', () => {
  let server: Server
  let base: string
  let destDir: string
  const BODY = Buffer.from('fake-dmg-content-#663')
  const SHA = createHash('sha512').update(BODY).digest('base64')

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), 'gugu-663-dl-'))
    server = createServer((req, res) => {
      if (req.url === '/redirect.dmg') {
        res.writeHead(302, { location: '/good.dmg' }); res.end(); return
      }
      if (req.url === '/good.dmg') {
        res.writeHead(200, { 'content-length': String(BODY.length) }); res.end(BODY); return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.close()
    await rm(destDir, { recursive: true, force: true })
  })

  it('downloads, verifies sha512, reports progress, lands at final name', async () => {
    const progress: number[] = []
    const p = await downloadDmg({
      fileUrl: `${base}/good.dmg`, expectedSha512: SHA, destDir,
      onProgress: (recv) => progress.push(recv)
    })
    expect(p).toBe(join(destDir, 'good.dmg'))
    expect(await readFile(p)).toEqual(BODY)
    expect(progress.at(-1)).toBe(BODY.length)
  })

  it('follows a 3xx redirect', async () => {
    const p = await downloadDmg({ fileUrl: `${base}/redirect.dmg`, expectedSha512: SHA, destDir })
    expect(await readFile(p)).toEqual(BODY)
  })

  it('sha512 mismatch → rejects and leaves no partial file', async () => {
    await expect(downloadDmg({ fileUrl: `${base}/good.dmg`, expectedSha512: 'bogus==', destDir }))
      .rejects.toThrow(/sha512/)
    expect(await readdir(destDir)).toEqual([])
  })

  it('HTTP error status → rejects and leaves no partial file', async () => {
    await expect(downloadDmg({ fileUrl: `${base}/missing.dmg`, destDir })).rejects.toThrow(/404/)
    expect(await readdir(destDir)).toEqual([])
  })
})

describe('#663 review 回归:sha512 空串拒绝 + 未知架构 fail loud', () => {
  it('empty-string sha512 is "present but invalid" → rejected, never silently skipped', async () => {
    const { createServer } = await import('node:http')
    const body = Buffer.from('x')
    const server = createServer((_req, res) => { res.writeHead(200); res.end(body) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const dir = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'gugu-663-empty-'))
    try {
      await expect(downloadDmg({ fileUrl: `http://127.0.0.1:${port}/a.dmg`, expectedSha512: '', destDir: dir }))
        .rejects.toThrow(/sha512/)
    } finally {
      server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('unsupported arch → throw (no silent x64 fallback)', () => {
    expect(() => pickMacDmgFile([{ url: 'gugu-1.0-x64.dmg' }], 'ia32')).toThrow(/不支持的架构/)
  })
})
