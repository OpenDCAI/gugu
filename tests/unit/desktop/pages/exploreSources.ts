import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 读「发现页的全部实现」。
 *
 * 这几条源码契约原本各自 readFile('…/ExplorePage.tsx')——把契约钉死在一个文件名上。
 * 一旦那个 1000 行的组件被拆开（本次就拆了），断言的字串搬到了兄弟文件里，测试就红，
 * 而契约其实一条没破。契约说的是「发现页的实现里必须/不得出现 X」，那就照这个范围读。
 */
const ROOT = 'apps/desktop/src/pages'
const SHELL = path.join(ROOT, 'ExplorePage.tsx')
const STYLES = path.join(ROOT, 'ExplorePage.css')
const PANES_DIR = path.join(ROOT, 'explore')

/** 发现页所有 .tsx 源码拼成一份（壳 + 各 pane）。 */
export async function readExploreSource(): Promise<string> {
  const files = await readdir(PANES_DIR)
  const parts = await Promise.all([
    readFile(SHELL, 'utf8'),
    ...files
      .filter((f) => f.endsWith('.tsx'))
      .sort()
      .map((f) => readFile(path.join(PANES_DIR, f), 'utf8')),
  ])
  return parts.join('\n')
}

/** 发现页样式表（原先内联在组件里的那段 CSS 已抽成真文件）。 */
export async function readExploreStyles(): Promise<string> {
  return readFile(STYLES, 'utf8')
}
