// #6629 闸:渲染层不许调 Monaco 的 `addCommand`。它把注册丢进进程级命令表后永不注销,
// handler 闭包连同挂载它的组件(实测:整个任务的会话 store,一个会话被钉住 12 份)一直活着。
// 要键位就用 `addAction`,并在卸载时 dispose 它返回的注册。
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../..')
const SCAN_ROOTS = ['apps/desktop/src', 'packages']
const ADD_COMMAND = /\.addCommand\s*\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}

describe('Monaco addCommand ban (#6629)', () => {
  it('installed Monaco still discards the addCommand registration (why the ban exists)', () => {
    const require = createRequire(import.meta.url)
    const file = join(
      dirname(require.resolve('monaco-editor/package.json')),
      'esm/vs/editor/standalone/browser/standaloneCodeEditor.js'
    )
    const source = readFileSync(file, 'utf8')
    const body = source.slice(source.indexOf('addCommand(keybinding, handler, context) {'), source.indexOf('createContextKey('))
    // 注册的返回值没人接住 ⇒ 永远注销不了。Monaco 哪天改成交回 disposable,这里先红,再重新评估这道闸。
    expect(body).toMatch(/\n\s+this\._standaloneKeybindingService\.addDynamicKeybinding\(/)
    expect(body).toContain('return commandId;')
  })

  it('no product source calls addCommand', () => {
    const hits = SCAN_ROOTS.flatMap((root) => sourceFiles(join(ROOT, root)))
      .filter((file) => ADD_COMMAND.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
    expect(hits).toEqual([])
  })

  it('the scan recognises a call (positive control)', () => {
    expect(ADD_COMMAND.test('modifiedEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, save)')).toBe(true)
    expect(ADD_COMMAND.test('editor.addAction({ id, label, run })')).toBe(false)
  })
})
