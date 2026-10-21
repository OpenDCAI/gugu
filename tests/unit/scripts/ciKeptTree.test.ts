import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { STAMP, afterInstall, beforeInstall } from '../../../scripts/ci-kept-tree.mjs'

// @@@kept-tree-stamp — 保住的依赖树只在上一次安装走完时可信。2026-09-30 PR #6847 的安装在 ENOENT 上
// 半路退出,留下改了一半的链接;pnpm 之后只比锁文件、判「Already up to date」,16 个槽里 14 个的
// desktop build 因悬空的 `@codemirror/view` 链接变红。

const script = path.resolve(__dirname, '../../../scripts/ci-kept-tree.mjs')
const roots: string[] = []

/** 一个保住了依赖树的工作区:根、workspace 包各有 node_modules,.pnpm 里还有嵌套的那一层。 */
function slotWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-tree-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  for (const dir of ['node_modules/.pnpm/codemirror@6.0.2/node_modules/codemirror', 'packages/core/node_modules/.bin', 'apps/desktop/src']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9.0\n')
  fs.writeFileSync(path.join(root, 'apps/desktop/src/main.ts'), '')
  return root
}

const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel))

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('保住的依赖树:上一次安装没走完就不沿用', () => {
  test('装到一半失败:下一个 job 进来把工作区里所有 node_modules 清掉,源码不动', () => {
    const root = slotWorkspace()
    afterInstall(root)
    // 这一个 job 撤了戳开始装,然后半路失败 —— 没有走到 afterInstall。
    beforeInstall(root)
    expect(exists(root, STAMP)).toBe(false)

    const next = beforeInstall(root)
    expect(next.cleared.map((dir) => path.relative(root, dir)).sort()).toEqual([
      'node_modules',
      path.join('packages', 'core', 'node_modules'),
    ])
    expect(exists(root, 'node_modules')).toBe(false)
    expect(exists(root, 'packages/core/node_modules')).toBe(false)
    expect(exists(root, 'apps/desktop/src/main.ts')).toBe(true)
  })

  test('上一次装完了、换分支:树原样留着给 pnpm 增量装,戳先撤、装完再立', () => {
    const root = slotWorkspace()
    afterInstall(root)
    // 换到另一份锁的分支:锁不同本身不是清树的理由。
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# another branch\n')

    expect(beforeInstall(root).cleared).toEqual([])
    expect(exists(root, 'node_modules/.pnpm/codemirror@6.0.2/node_modules/codemirror')).toBe(true)
    expect(exists(root, 'packages/core/node_modules/.bin')).toBe(true)
    expect(exists(root, STAMP), '装的过程中不能留着上一次的戳').toBe(false)

    afterInstall(root)
    expect(exists(root, STAMP)).toBe(true)
  })

  test('全新的工作区(还没有 node_modules):什么都不清', () => {
    const root = slotWorkspace()
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true })
    fs.rmSync(path.join(root, 'packages/core/node_modules'), { recursive: true })
    expect(beforeInstall(root).cleared).toEqual([])
  })

  test('部署之前留下来的树(从来没有戳)按没走完处理', () => {
    // 这条让已经被弄坏、又没人去清的槽在修法上线后的第一个 job 自愈。
    const root = slotWorkspace()
    expect(beforeInstall(root).cleared).toHaveLength(2)
  })

  test('命令行:清树时在日志里响亮地说出来', () => {
    const root = slotWorkspace()
    const out = execFileSync(process.execPath, [script, '--before-install'], { cwd: root, encoding: 'utf8' })
    expect(out).toMatch(/::warning::上一次安装没走完/)
    fs.mkdirSync(path.join(root, 'node_modules')) // 这一次的 pnpm install 重建了它
    execFileSync(process.execPath, [script, '--after-install'], { cwd: root })
    expect(execFileSync(process.execPath, [script, '--before-install'], { cwd: root, encoding: 'utf8' })).toMatch(
      /kept tree/,
    )
  })

  test('经符号链接调用也照样干活,不是什么都不做就 exit 0', () => {
    const root = slotWorkspace()
    const linked = path.join(root, 'linked-ci-kept-tree.mjs')
    fs.symlinkSync(script, linked)
    const out = execFileSync(process.execPath, [linked, '--before-install'], { cwd: root, encoding: 'utf8' })
    expect(out).toMatch(/::warning::上一次安装没走完/)
    expect(exists(root, 'node_modules')).toBe(false)
  })
})
