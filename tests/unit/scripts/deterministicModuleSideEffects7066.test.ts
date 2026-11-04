import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { deterministicModuleSideEffects, sideEffectsRule } from '../../../scripts/build/deterministic-module-side-effects.mjs'

/*
 * #7066 同一个 sha 打两次 dist-electron 不一样:rollup 只认模块第一次被解析时的 moduleSideEffects,而同一个文件经别名
 * 与经包内相对路径解析会得到不同的值。插件在 transform 里按「最近的 package.json 的 sideEffects」重新给值,
 * 这里守三件事:规则与 vite 的 packageData.hasSideEffects 一致;同一个文件不管从哪条路过来,插件给的值都只由文件本身决定;
 * vite.config.mts 的每一次 rollup 构建(渲染层、主进程与无头宿主、两个 preload)都真的挂着它 —— 竞态在单测里造不出来,
 * 漏挂一处就只能靠这一条发现。
 */

const repoRoot = join(__dirname, '../../..')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gugu-mse-'))
  scratch.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

type Handler = (code: string, id: string) => { moduleSideEffects: boolean } | null
const handlerOf = (): Handler =>
  (deterministicModuleSideEffects().transform as unknown as { handler: Handler }).handler

describe('sideEffectsRule(package.json 的 sideEffects → 这个文件有没有副作用)', () => {
  it('布尔值原样;没有这个字段 = rollup 的默认 true', () => {
    expect(sideEffectsRule(false, '/p')('/p/a.ts')).toBe(false)
    expect(sideEffectsRule(true, '/p')('/p/a.ts')).toBe(true)
    expect(sideEffectsRule(undefined, '/p')('/p/a.ts')).toBe(true)
  })

  it('数组:空数组 = 全无副作用;不带 / 的模式匹配任意目录下的同名文件,带 / 的按包目录解析', () => {
    expect(sideEffectsRule([], '/p')('/p/a.ts')).toBe(false)
    const rule = sideEffectsRule(['*.css.ts', './src/polyfill.ts'], '/p')
    expect(rule('/p/src/deep/theme.css.ts')).toBe(true)
    expect(rule('/p/src/polyfill.ts')).toBe(true)
    expect(rule('/p/src/other.ts')).toBe(false) // 阴控:不在名单里的文件是 false
    expect(rule('/p/lib/polyfill.ts')).toBe(false) // 阴控:带 / 的模式只认那一个路径
  })
})

describe('deterministicModuleSideEffects(transform 里按文件本身给值)', () => {
  it('按离文件最近的 package.json 给值,子目录里没有 package.json 就往上找', () => {
    const root = tree({
      'pkg-false/package.json': JSON.stringify({ name: 'a', sideEffects: false }),
      'pkg-false/src/files/index.ts': 'export * from "./errors"\n',
      'pkg-list/package.json': JSON.stringify({ name: 'b', sideEffects: ['*.css.ts'] }),
      'pkg-list/src/theme.css.ts': '',
      'pkg-list/src/view.ts': '',
      'pkg-none/package.json': JSON.stringify({ name: 'c' }),
      'pkg-none/src/x.ts': '',
    })
    const handler = handlerOf()
    expect(handler('', join(root, 'pkg-false/src/files/index.ts'))).toEqual({ moduleSideEffects: false })
    expect(handler('', join(root, 'pkg-list/src/theme.css.ts'))).toEqual({ moduleSideEffects: true })
    expect(handler('', join(root, 'pkg-list/src/view.ts'))).toEqual({ moduleSideEffects: false })
    expect(handler('', join(root, 'pkg-none/src/x.ts'))).toEqual({ moduleSideEffects: true })
  })

  it('包里只写了 type 的 package.json(dist/esm 之类)不是包清单,不遮包根上声明的 sideEffects', () => {
    const root = tree({
      'node_modules/entities/package.json': JSON.stringify({ name: 'entities', sideEffects: false }),
      'node_modules/entities/dist/esm/package.json': JSON.stringify({ type: 'module' }),
      'node_modules/entities/dist/esm/index.js': '',
      'node_modules/plain/package.json': JSON.stringify({ name: 'plain' }),
      'node_modules/plain/dist/esm/package.json': JSON.stringify({ type: 'module', sideEffects: false }),
      'node_modules/plain/dist/esm/index.js': '',
    })
    const handler = handlerOf()
    expect(handler('', join(root, 'node_modules/entities/dist/esm/index.js'))).toEqual({ moduleSideEffects: false })
    // 阴控:没有 name 的那层即使写了 sideEffects 也不算,按包根(没声明 = true)
    expect(handler('', join(root, 'node_modules/plain/dist/esm/index.js'))).toEqual({ moduleSideEffects: true })
  })

  it('同一个文件问多少次、什么顺序都是同一个值(竞态里谁先到都一样)', () => {
    const root = tree({ 'p/package.json': JSON.stringify({ name: 'p', sideEffects: false }), 'p/src/barrel.ts': '' })
    const id = join(root, 'p/src/barrel.ts')
    const first = handlerOf()
    const second = handlerOf()
    expect([first('a', id), first('b', id), second('c', id)]).toEqual([
      { moduleSideEffects: false },
      { moduleSideEffects: false },
      { moduleSideEffects: false },
    ])
  })

  it('不碰虚拟模块、带查询串的模块与非脚本文件(它们的值由各自的插件定)', () => {
    const handler = handlerOf()
    expect(handler('', '\0commonjsHelpers.js')).toBeNull()
    expect(handler('', '/p/node_modules/x/index.js?commonjs-proxy')).toBeNull()
    expect(handler('', '/p/src/style.css')).toBeNull()
    expect(handler('', '/p/src/data.json')).toBeNull()
  })
})

describe('vite.config.mts 的每一次 rollup 构建都挂着这个插件', () => {
  it('渲染层、electronBuildEntries 每一项(主进程 / 两个 preload)、sessionHostBuildEntries 每一项', () => {
    // 与 build-electron-app.mts 同一种加载法(tsx 直接 import vite.config.mts,拿得到具名导出的构建入口);渲染层的配置是
    // defineConfig 包着的函数,按 build 调一次。插件列表可以嵌套(vite 允许),先拍平再按 name 找。
    const code = `
      const name = 'gugu-deterministic-module-side-effects'
      const has = (plugins) => [plugins ?? []].flat(Infinity).some((p) => p && typeof p === 'object' && p.name === name)
      const m = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'vite.config.mts')).href)})
      const renderer = typeof m.default === 'function' ? m.default({ command: 'build', mode: 'production' }) : m.default
      process.stdout.write('READING ' + JSON.stringify({
        renderer: has(renderer.plugins),
        electron: m.electronBuildEntries.map((e) => has(e.vite?.plugins)),
        host: m.sessionHostBuildEntries.map((e) => has(e.vite?.plugins)),
      }))`
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    })
    const line = run.stdout.split(/\r?\n/).find((l) => l.startsWith('READING '))
    expect(line, `${run.stdout}${run.stderr}`).toBeTruthy()
    const reading = JSON.parse(line!.slice('READING '.length)) as { renderer: boolean; electron: boolean[]; host: boolean[] }
    expect(reading.electron.length).toBeGreaterThanOrEqual(3)
    expect(reading).toEqual({
      renderer: true,
      electron: reading.electron.map(() => true),
      host: reading.host.map(() => true),
    })
  }, 120_000)
})
