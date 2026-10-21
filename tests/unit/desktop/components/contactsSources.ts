import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * 读「通讯录的全部实现」。
 *
 * 源码契约说的是「通讯录实现里必须/不得出现 X」，不是「ContactsPanel.tsx 这个文件里」。
 * 那个 4900 行的文件正在按 component-refactoring 逐块拆开，把契约钉死在文件名上，
 * 每拆一次就假红一次，而契约一条没破。
 */
const PANEL = 'apps/desktop/src/components/ContactsPanel.tsx'
const DIR = 'apps/desktop/src/components/contacts'

export async function readContactsSource(): Promise<string> {
  const files = await readdir(DIR)
  const parts = await Promise.all([
    readFile(PANEL, 'utf8'),
    ...files.filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).sort()
      .map((f) => readFile(path.join(DIR, f), 'utf8')),
  ])
  return parts.join('\n')
}
