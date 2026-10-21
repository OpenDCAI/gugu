import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { lockfileScopedModuleCacheDir } from '../../../scripts/vitest-module-cache-dir'

describe('vitest fs module cache is scoped to the lockfile (#6517)', () => {
  it('never hands a run the cache that was transformed under another lockfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'module-cache-'))
    writeFileSync(join(root, 'pnpm-lock.yaml'), "node-pty@1.1.0(patch_hash=0541e4)\n")
    const underA = lockfileScopedModuleCacheDir(root)
    // 同一份锁文件 ⇒ 同一格:缓存照常复用,这是开它的全部意义。
    expect(lockfileScopedModuleCacheDir(root)).toBe(underA)
    mkdirSync(underA, { recursive: true })
    writeFileSync(join(underA, 'local-pty.test.ts'), '__vi_ssr_import__("/node_modules/.pnpm/node-pty@1.1.0_patch_hash=0541e4/…")')

    const parent = dirname(underA)
    // 分格之前平铺的旧缓存条目与 vitest 的 metadata:vitest 4.1 正是信了一个没有 metadata 的平铺缓存才出事。
    writeFileSync(join(parent, '97e547200725a8209ae68c92636028c44127a5da'), 'flat entry from before #6517')
    writeFileSync(join(parent, '_metadata.json'), '{"lockfileHash":"a0a3646c"}')

    writeFileSync(join(root, 'pnpm-lock.yaml'), 'node-pty@1.1.0\n')
    const underB = lockfileScopedModuleCacheDir(root)
    expect(underB).not.toBe(underA)
    expect(dirname(underB)).toBe(parent)
    // 这条红 = 换了依赖的运行还能读到按旧锁文件转的模块(#6493 的 vi.mock 静默落空)。
    expect(existsSync(underA)).toBe(false)
    expect(readdirSync(parent)).toEqual([])
  })

  it('works on a slot that has never had a cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'module-cache-'))
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    const dir = lockfileScopedModuleCacheDir(root)
    expect(dir.startsWith(join(root, 'node_modules', '.experimental-vitest-cache'))).toBe(true)
    expect(existsSync(dirname(dir))).toBe(false)
  })
})
