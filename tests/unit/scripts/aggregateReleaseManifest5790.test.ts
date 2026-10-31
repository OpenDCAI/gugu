// @@@5790 总清单的合成:它替代的是「四个平台各写一次全局对象、最后写的赢」。
// 所以这里钉的核心不是"能合出来",而是**少一个平台必须炸**——v0.2.44 那次线上
// platforms 只剩 ["mac"],四个平台的产物其实都在 OSS 上,而没有任何一处判据会红。
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

type Fragment = { version: string; platform: { platform: string } }
const require = createRequire(import.meta.url)
const { buildManifest, parseExpected, readFragment } = require('../../../scripts/release/aggregate-release-manifest.cjs') as {
  buildManifest(input: {
    productName: string
    version: string
    releaseDate: string
    expected: string[]
    fragments: Map<string, Fragment>
  }): { version: string; platforms: { platform: string }[] }
  parseExpected(argv: string[]): string[]
  readFragment(
    client: { get(key: string): Promise<{ content: Buffer }> },
    platform: string,
    version: string,
  ): Promise<Fragment>
}

const VERSION = '0.2.44'
const fragmentFor = (platform: string) => ({
  name: 'gugu',
  productName: '咕咕',
  version: VERSION,
  platform: { platform, stableAliases: [], files: [{ name: `gugu-${VERSION}-${platform}` }] },
})
const fragmentsFor = (platforms: string[]) =>
  new Map(platforms.map((p) => [p, fragmentFor(p)]))

const build = (expected: string[], have: string[]) =>
  buildManifest({
    productName: '咕咕',
    version: VERSION,
    releaseDate: '2026-09-18T01:11:34.236Z',
    expected,
    fragments: fragmentsFor(have),
  })

describe('#5790 总清单的合成', () => {
  test('四个平台齐全时合出四格,顺序按声明而不是读回来的先后', () => {
    const manifest = build(['mac', 'windows', 'android', 'linux'], ['linux', 'mac', 'android', 'windows'])
    expect(manifest.version).toBe(VERSION)
    expect(manifest.platforms.map((p: { platform: string }) => p.platform)).toEqual([
      'mac',
      'windows',
      'android',
      'linux',
    ])
  })

  // 这条就是本 issue 的形状:少一格必须炸,且要点名是谁 —— 静默接受等于原样复发。
  test('少一个平台就炸,并点名缺的是谁', () => {
    expect(() => build(['mac', 'windows', 'android', 'linux'], ['mac', 'android', 'linux'])).toThrow(
      /windows/,
    )
  })

  test('片段版本与本次发布对不上时炸 —— 上一版残留的对象不能充数', () => {
    const fragments = fragmentsFor(['mac', 'linux'])
    fragments.get('linux')!.version = '0.2.43'
    expect(() =>
      buildManifest({
        productName: '咕咕',
        version: VERSION,
        releaseDate: 'x',
        expected: ['mac', 'linux'],
        fragments,
      }),
    ).toThrow(/0\.2\.43/)
  })

  test('片段里的 platform 字段对不上时炸', () => {
    const fragments = fragmentsFor(['mac'])
    fragments.get('mac')!.platform.platform = 'windows'
    expect(() =>
      buildManifest({ productName: '咕咕', version: VERSION, releaseDate: 'x', expected: ['mac'], fragments }),
    ).toThrow(/platform/)
  })

  // ❌ 不许从"OSS 上碰巧有什么"反推:那样一个平台没出包就会被当成"本来就不该有"。
  test('不给 --expect 就炸,不许静默接受任意平台集合', () => {
    expect(() => parseExpected(['node', 'x'])).toThrow(/--expect/)
    expect(parseExpected(['node', 'x', '--expect', 'mac, windows ,linux'])).toEqual([
      'mac',
      'windows',
      'linux',
    ])
  })
})

// 某个平台压根没出包 → 它的片段不存在。这条是本次新增的核心失败模式,
// ❌ 不该等到真发版那天才第一次走到:报错必须点名是哪个对象、为什么取不到。
describe('#5790 片段取不到时的报错', () => {
  const stub = (fail: 'missing' | 'broken') => ({
    get: async (key: string) => {
      if (fail === 'missing') {
        const err = new Error('NoSuchKey') as Error & { status?: number }
        err.status = 404
        throw err
      }
      return { content: Buffer.from('not json', 'utf8') as Buffer, key } as { content: Buffer }
    },
  })

  test('对象不存在时点名那个 key 并说明是 404', async () => {
    await expect(readFragment(stub('missing'), 'windows', '0.2.44')).rejects.toThrow(
      /releases\/windows\/0\.2\.44\/manifest\.json.*404/s,
    )
  })

  test('对象在但不是合法 JSON 时也要炸,❌ 不能当成"没有这个平台"静默跳过', async () => {
    await expect(readFragment(stub('broken'), 'linux', '0.2.44')).rejects.toThrow(
      /releases\/linux\/0\.2\.44\/manifest\.json/,
    )
  })
})
