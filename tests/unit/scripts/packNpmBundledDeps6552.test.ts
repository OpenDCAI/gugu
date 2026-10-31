import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { packNpmBundledDependencies, packedAppDir } = require('../../../scripts/build/pack-npm-bundled-deps.cjs') as {
  packNpmBundledDependencies: (opts: { appDir: string; repoRoot: string }) => number
  packedAppDir: (context: unknown) => string
}

const repoRoot = path.resolve(__dirname, '../../..')
const sourceNpm = path.dirname(require.resolve('npm/package.json', { paths: [repoRoot] }))

// #6552 electron-builder 的拷贝不 walk 进 `node_modules`,npm 的 bundleDependencies 整棵被丢(Windows Beta:
// 包里的 npm 一跑就 `Cannot find module 'graceful-fs'`)。这里造一个「electron-builder 拷完之后」的 app 目录:
// npm 本体在、它自己的 node_modules 不在 —— 与装出来的 Beta 一模一样。
describe('包里的 npm 带上它自己的依赖 (#6552)', () => {
  let appDir: string
  beforeEach(() => {
    appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-app-'))
    const packedNpm = path.join(appDir, 'node_modules', 'npm')
    fs.mkdirSync(packedNpm, { recursive: true })
    fs.copyFileSync(path.join(sourceNpm, 'package.json'), path.join(packedNpm, 'package.json'))
  })
  afterEach(() => fs.rmSync(appDir, { recursive: true, force: true }))

  test('阳性对照:拷完之后的 npm 确实缺 graceful-fs', () => {
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'npm', 'node_modules', 'graceful-fs'))).toBe(false)
  })

  test('补回 npm 声明的每一个 bundled 依赖', () => {
    const count = packNpmBundledDependencies({ appDir, repoRoot })
    expect(count).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(appDir, 'node_modules', 'npm', 'node_modules', 'graceful-fs', 'package.json'))).toBe(true)
  })

  test('npm bundled dependencies do not reintroduce nested source maps after files filtering', () => {
    const sourceModules = path.join(sourceNpm, 'node_modules')
    const sourceMaps = fs.readdirSync(sourceModules, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.map'))
    expect(sourceMaps.length).toBeGreaterThan(0)
    packNpmBundledDependencies({ appDir, repoRoot })
    const packedModules = path.join(appDir, 'node_modules', 'npm', 'node_modules')
    expect(fs.readdirSync(packedModules, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.map'))).toEqual([])
  })

  test('包里没有 npm 就让打包失败', () => {
    fs.rmSync(path.join(appDir, 'node_modules', 'npm'), { recursive: true, force: true })
    expect(() => packNpmBundledDependencies({ appDir, repoRoot })).toThrow(/包里没有 npm/)
  })

  test('app 目录按平台定位(asar 关着)', () => {
    const packager = { appInfo: { productFilename: '咕咕 Beta' } }
    expect(packedAppDir({ electronPlatformName: 'win32', appOutDir: '/out/win-unpacked', packager }))
      .toBe(path.join('/out/win-unpacked', 'resources', 'app'))
    expect(packedAppDir({ electronPlatformName: 'darwin', appOutDir: '/out/mac', packager }))
      .toBe(path.join('/out/mac', '咕咕 Beta.app', 'Contents', 'Resources', 'app'))
  })
})
