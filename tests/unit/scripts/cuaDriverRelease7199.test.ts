import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertPeMachine, CUA_DRIVER_MAC_REVISION, CUA_DRIVER_VERSION, cuaDriverArchiveInfo, obtainVerifiedArchive, parseCuaTools } from '../../../scripts/cua-driver-release.mjs'

// #7199 打包带的 cua-driver:归档按钉住的 sha256 校验、内容寻址缓存;工具清单与 exe 架构对不上就响亮失败。
const CONTENT = 'fake cua-driver archive bytes'
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const ASSET = 'cua-driver-rs-0.0.0-darwin-universal-binary.tar.gz'
const URL = `https://example.invalid/${ASSET}`
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-7199-cua-'))
  dirs.push(dir)
  return dir
}
const quiet = { log: () => {}, warn: () => {} }

describe('#7514 maintained macOS driver distribution', () => {
  it('packages the maintained Mac archive, retaining upstream Windows distributions', () => {
    const mac = cuaDriverArchiveInfo('darwin-universal')
    expect(mac.asset).toContain(CUA_DRIVER_MAC_REVISION)
    expect(mac.url).toBe(`https://github.com/OpenDCAI/gugu/releases/download/assets/${mac.asset}`)
    expect(mac.sha256).toMatch(/^[a-f0-9]{64}$/)
    for (const arch of ['x64', 'arm64']) expect(cuaDriverArchiveInfo(`win32-${arch}`).url).toContain(`trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/`)
    expect(() => cuaDriverArchiveInfo('unknown')).toThrow('没有钉')
  })

  it('keeps the exact source patch alongside the binary revision', () => {
    const dir = join(__dirname, '../../../apps/desktop/native/cua-driver')
    const metadata = JSON.parse(readFileSync(join(dir, 'patched-macos.json'), 'utf8'))
    expect(metadata.revision).toBe(CUA_DRIVER_MAC_REVISION)
    expect(createHash('sha256').update(readFileSync(join(dir, metadata.patch))).digest('hex')).toBe(metadata.patchSha256)
    expect(metadata.upstreamCommit).toMatch(/^[a-f0-9]{40}$/)
  })
})

describe('#7199 cua-driver 归档缓存', () => {
  it('未命中下载一次、按 sha256/文件名 落缓存;再取命中,不再下载', () => {
    const cacheDir = tempDir()
    const calls: string[] = []
    const download = (url: string, destination: string) => {
      calls.push(url)
      writeFileSync(destination, CONTENT)
    }
    const input = { url: URL, asset: ASSET, sha256: SHA, cacheDir, download, ...quiet }
    expect(obtainVerifiedArchive(input)).toBe(join(cacheDir, SHA, ASSET))
    expect(obtainVerifiedArchive(input)).toBe(join(cacheDir, SHA, ASSET))
    expect(calls).toEqual([URL])
    expect(readdirSync(join(cacheDir, SHA))).toEqual([ASSET])
  })

  it('下载到的内容 sha256 对不上:报错,两个值都说出来,什么都不缓存', () => {
    const cacheDir = tempDir()
    const download = (_url: string, destination: string) => writeFileSync(destination, `${CONTENT} tampered`)
    expect(() => obtainVerifiedArchive({ url: URL, asset: ASSET, sha256: SHA, cacheDir, download, ...quiet })).toThrow(`钉住的是 ${SHA}`)
    expect(readdirSync(join(cacheDir, SHA))).toEqual([])
  })

  it('缓存里的文件坏了:丢掉重下,❌ 将就用', () => {
    const cacheDir = tempDir()
    let downloads = 0
    const download = (_url: string, destination: string) => {
      downloads += 1
      writeFileSync(destination, CONTENT)
    }
    const input = { url: URL, asset: ASSET, sha256: SHA, cacheDir, download, ...quiet }
    obtainVerifiedArchive(input)
    writeFileSync(join(cacheDir, SHA, ASSET), 'truncated')
    expect(obtainVerifiedArchive(input)).toBe(join(cacheDir, SHA, ASSET))
    expect(downloads).toBe(2)
  })

  it('下载失败:报错,不留 .part', () => {
    const cacheDir = tempDir()
    const download = (_url: string, destination: string) => {
      writeFileSync(destination, 'partial')
      throw Object.assign(new Error('curl failed'), { status: 56 })
    }
    expect(() => obtainVerifiedArchive({ url: URL, asset: ASSET, sha256: SHA, cacheDir, download, ...quiet })).toThrow('curl exit 56')
    expect(existsSync(join(cacheDir, SHA, ASSET))).toBe(false)
    expect(readdirSync(join(cacheDir, SHA))).toEqual([])
  })
})

describe('#7199 cua-tools.json', () => {
  const doc = (overrides: object) => JSON.stringify({ tools: [{ name: 'list_apps', description: 'd', input_schema: {} }], version: CUA_DRIVER_VERSION, ...overrides })

  it('版本对、工具非空且都有 name:原样写出', () => {
    const text = doc({})
    expect(parseCuaTools(text)).toBe(`${text}\n`)
  })

  it('版本不是钉住的、清单为空、工具缺 name:都报错', () => {
    expect(() => parseCuaTools(doc({ version: '9.9.9' }))).toThrow('9.9.9')
    expect(() => parseCuaTools(doc({ tools: [] }))).toThrow('空的')
    expect(() => parseCuaTools(doc({ tools: [{ description: 'no name' }] }))).toThrow('没有 name')
  })
})

describe('#7199 Windows exe 的架构', () => {
  function pe(machine: number): string {
    const buf = Buffer.alloc(0x100)
    buf.write('MZ', 0, 'latin1')
    buf.writeUInt32LE(0x80, 0x3c)
    buf.write('PE\0\0', 0x80, 'latin1')
    buf.writeUInt16LE(machine, 0x84)
    const file = join(tempDir(), 'cua-driver.exe')
    writeFileSync(file, buf)
    return file
  }

  it('Machine 字段与目标架构一致才放行', () => {
    expect(() => assertPeMachine(pe(0x8664), 'x64')).not.toThrow()
    expect(() => assertPeMachine(pe(0xaa64), 'arm64')).not.toThrow()
    expect(() => assertPeMachine(pe(0x8664), 'arm64')).toThrow('不是 arm64')
    expect(() => assertPeMachine(pe(0xaa64), 'x64')).toThrow('不是 x64')
  })

  it('不是 PE 文件:报错', () => {
    const file = join(tempDir(), 'not.exe')
    writeFileSync(file, 'not a PE file at all')
    expect(() => assertPeMachine(file, 'x64')).toThrow('PE Machine')
  })
})
