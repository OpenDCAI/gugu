import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { cacheBucket, eslintArgs } from '../../../scripts/eslint-cached.mts'
import {
  nativeRebuildNeeded,
  packageJsonNativeFieldsChanged,
  pathNeedsNativeRebuild,
} from '../../../scripts/native-rebuild-needed.mts'
import {
  STASH_SUFFIX,
  removeNewEntries,
  restoreBuild,
  snapshotEntries,
  stashBuild,
} from '../../../scripts/rebuild-native-isolated.mts'

const repoRoot = path.resolve(__dirname, '../../..')
const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>

// @@@6270 PR CI 的构建变体只许比发布用的那条**少**两段,❌ 不许悄悄多出或少掉别的:
// 少掉的 tsgo 由 policy 的 `pnpm typecheck` 跑(同一份根 tsconfig,tsgo 不读 GUGU_TARGET),
// 少掉的 rebuild:native 由 `rebuild:native:isolated` 按需跑。其余每一段都必须一字不差。
describe('PR CI 构建变体与发布构建同源(#6270)', () => {
  test('build:app:ci = build:app 去掉 tsgo 与 rebuild:native', () => {
    const full = scripts['build:app'].split(' && ')
    expect(full).toContain('tsgo --noEmit')
    expect(full).toContain('pnpm rebuild:native')
    const expected = full.filter((step) => step !== 'tsgo --noEmit' && step !== 'pnpm rebuild:native')
    expect(scripts['build:app:ci'].split(' && ')).toEqual(expected)
  })

  test('build:renderer:ci = build:renderer 去掉 tsgo', () => {
    const full = scripts['build:renderer'].split(' && ')
    expect(full).toContain('GUGU_TARGET=web tsgo --noEmit')
    expect(scripts['build:renderer:ci'].split(' && ')).toEqual(
      full.filter((step) => step !== 'GUGU_TARGET=web tsgo --noEmit'),
    )
  })

  test('typecheck 跑的正是构建里被去掉的那条 tsgo', () => {
    expect(scripts.typecheck.split(' && ')).toContain('tsgo --noEmit')
  })

  test('rebuild:native:isolated 跑的正是 rebuild:native 的两段', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'scripts/rebuild-native-isolated.mts'), 'utf8')
    for (const step of scripts['rebuild:native'].split(' && ')) {
      expect(src).toContain(`'${step.replace(/^node /, '')}'`)
    }
  })
})

describe('eslint 缓存(#6270)', () => {
  test('缓存键里补上 lockfile:lockfile 不同 ⇒ 桶不同', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-bucket-'))
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-bucket-'))
    try {
      fs.writeFileSync(path.join(a, 'pnpm-lock.yaml'), 'eslint@8.57.1\n')
      fs.writeFileSync(path.join(b, 'pnpm-lock.yaml'), 'eslint@8.57.2\n')
      expect(cacheBucket(a)).not.toBe(cacheBucket(b))
      expect(cacheBucket(a)).toBe(cacheBucket(a))
    } finally {
      fs.rmSync(a, { recursive: true, force: true })
      fs.rmSync(b, { recursive: true, force: true })
    }
  })

  test('必须是 content 策略(CI checkout 会刷新 mtime),目录以 / 结尾', () => {
    const args = eslintArgs(['.'], { bucketDir: '/x/bucket', noCache: false })
    expect(args).toEqual(['.', '--cache', '--cache-strategy', 'content', '--cache-location', '/x/bucket/'])
    expect(eslintArgs(['.'], { bucketDir: '/x', noCache: true })).toEqual(['.'])
  })

  test('lint 的 eslint 段参数与改动前一致', () => {
    expect(scripts['lint:eslint']).toContain(
      '. --ext .ts,.tsx,.js,.cjs,.mjs,.mts --report-unused-disable-directives --max-warnings 0',
    )
  })
})

describe('原生重编的触发判据(#6270)', () => {
  test.each([
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches/node-pty@1.1.0.patch',
    'scripts/rebuild-native.cjs',
    'scripts/verify-dev-native-probe.cjs',
    'scripts/native-addon-build-policy.cjs',
    '.node-version',
  ])('%s 变了要重编', (file) => {
    expect(pathNeedsNativeRebuild(file)).toBe(true)
  })

  test.each(['apps/desktop/src/App.tsx', 'scripts/build-provenance.mjs', 'README.md'])('%s 变了不必重编', (file) => {
    expect(pathNeedsNativeRebuild(file)).toBe(false)
  })

  test('package.json 只改 scripts 不触发,改依赖触发', () => {
    const base = JSON.stringify({ scripts: { a: '1' }, devDependencies: { electron: '44.0.0' } })
    expect(packageJsonNativeFieldsChanged(base, JSON.stringify({ scripts: { a: '2' }, devDependencies: { electron: '44.0.0' } }))).toBe(false)
    expect(packageJsonNativeFieldsChanged(base, JSON.stringify({ scripts: { a: '1' }, devDependencies: { electron: '45.0.0' } }))).toBe(true)
    expect(packageJsonNativeFieldsChanged(base, '{ broken')).toBe(true)
  })

  test('拿不到两份 package.json 时一改就算需要(宁多编一次)', () => {
    expect(nativeRebuildNeeded(['package.json']).needed).toBe(true)
    expect(nativeRebuildNeeded(['apps/desktop/src/App.tsx']).needed).toBe(false)
  })
})

describe('隔离重编:槽的原生模块原样还回去(#6270)', () => {
  function pkg() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-iso-'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    return dir
  }

  test('原有 build/ 挪开再挪回,内容与 inode 都不变,重编产物被丢掉', () => {
    const dir = pkg()
    try {
      fs.mkdirSync(path.join(dir, 'build/Release'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'build/Release/a.node'), 'node-abi')
      const inode = fs.statSync(path.join(dir, 'build/Release/a.node')).ino
      const before = snapshotEntries(dir)
      stashBuild(dir)
      expect(fs.existsSync(path.join(dir, 'build'))).toBe(false)
      // 模拟 electron-rebuild:新的 build/ 与 build/ 之外的缓存目录
      fs.mkdirSync(path.join(dir, 'build/Release'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'build/Release/a.node'), 'electron-abi')
      fs.mkdirSync(path.join(dir, 'bin/darwin-arm64-149'), { recursive: true })
      expect(restoreBuild(dir)).toBe(true)
      expect(removeNewEntries(dir, before)).toEqual(['bin'])
      expect(fs.readFileSync(path.join(dir, 'build/Release/a.node'), 'utf8')).toBe('node-abi')
      expect(fs.statSync(path.join(dir, 'build/Release/a.node')).ino).toBe(inode)
      expect(fs.readdirSync(dir).sort()).toEqual(['build', 'package.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('原来没有 build/(node-pty 走 prebuilds)⇒ 还原后也不留 build/', () => {
    const dir = pkg()
    try {
      stashBuild(dir)
      fs.mkdirSync(path.join(dir, 'build/Release'), { recursive: true })
      expect(restoreBuild(dir)).toBe(true)
      expect(fs.readdirSync(dir)).toEqual(['package.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('没有 stash 时还原是空操作;残留 stash 时拒绝再挪一次', () => {
    const dir = pkg()
    try {
      expect(restoreBuild(dir)).toBe(false)
      stashBuild(dir)
      expect(fs.existsSync(path.join(dir, 'build' + STASH_SUFFIX))).toBe(true)
      expect(() => stashBuild(dir)).toThrow(/已存在/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
