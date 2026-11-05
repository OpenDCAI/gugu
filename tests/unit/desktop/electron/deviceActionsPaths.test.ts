// #7199 文件位置的授权:只认连上了的根;按真实位置判(借符号链接跳不出去);还不存在的路径按最近一个存在的上级判。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveInsideRoots, resolveTargetInsideRoots } from '../../../../apps/desktop/electron/device-actions/paths'

let dir: string
let home: string
const realHome = process.env.HOME

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-dapaths-')))
  home = path.join(dir, 'home')
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Elsewhere']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, 'Documents', 'note.txt'), '文稿里的笔记')
  fs.writeFileSync(path.join(home, 'Desktop', 'todo.txt'), '桌面上的待办')
  // 文稿里放一个指向桌面的链接:借它跳到没连上的位置 ⇒ 要被拦下。
  fs.symlinkSync(path.join(home, 'Desktop', 'todo.txt'), path.join(home, 'Documents', 'sneaky.txt'))
  fs.symlinkSync(path.join(home, 'Desktop'), path.join(home, 'Documents', 'desk-link'))
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(dir, { recursive: true, force: true })
})

const granted = (...roots: string[]) => new Set(roots)

describe('文件位置的授权', () => {
  it('只认连上了的根;符号链接按真实位置判', async () => {
    const docs = granted('files.documents')
    expect(await resolveInsideRoots('~/Documents/note.txt', docs)).toEqual({ ok: true, path: path.join(home, 'Documents', 'note.txt') })
    expect(await resolveInsideRoots('~/Desktop/todo.txt', docs)).toMatchObject({ ok: false })
    expect(await resolveInsideRoots('~/Documents/sneaky.txt', docs)).toMatchObject({ ok: false })
    expect(await resolveInsideRoots('~/Elsewhere', docs)).toMatchObject({ ok: false })
    expect(await resolveInsideRoots('Documents/note.txt', docs)).toMatchObject({ ok: false, message: expect.stringContaining('absolute') })
    expect(await resolveInsideRoots('~/Documents/note.txt', granted())).toMatchObject({ ok: false, message: expect.stringContaining('No file location') })
    // 「其他位置」不含桌面:桌面要单独连。
    expect(await resolveInsideRoots('~/Elsewhere', granted('files.other'))).toMatchObject({ ok: true })
    expect(await resolveInsideRoots('~/Desktop/todo.txt', granted('files.other'))).toMatchObject({ ok: false })
  })

  it('字面上就在没连上的位置:当场拒,❌ 去碰磁盘(碰了 macOS 就会为那个文件夹弹授权框)', async () => {
    const realpath = vi.spyOn(fs.promises, 'realpath')
    expect(await resolveInsideRoots('~/Desktop/todo.txt', granted('files.documents'))).toMatchObject({ ok: false })
    expect(await resolveTargetInsideRoots('~/desktop/new.txt', granted('files.documents'))).toMatchObject({ ok: false })
    expect(await resolveInsideRoots('/etc/hosts', granted('files.other'))).toMatchObject({ ok: false })
    expect(realpath).not.toHaveBeenCalled()
    realpath.mockRestore()
  })

  it('还不存在的路径(要写 / 要建):按最近一个存在的上级的真实位置判;.. 与链接都跳不出去', async () => {
    const docs = granted('files.documents')
    expect(await resolveTargetInsideRoots('~/Documents/new/deeper/file.txt', docs)).toEqual({ ok: true, path: path.join(home, 'Documents', 'new', 'deeper', 'file.txt') })
    expect(await resolveTargetInsideRoots('~/Documents/../Desktop/x.txt', docs)).toMatchObject({ ok: false })
    expect(await resolveTargetInsideRoots('~/Documents/desk-link/x.txt', docs)).toMatchObject({ ok: false })
    expect(await resolveTargetInsideRoots('~/Desktop/x.txt', granted('files.desktop'))).toEqual({ ok: true, path: path.join(home, 'Desktop', 'x.txt') })
  })
})
