// 主进程 bundle 里带标签模板的 raw 段含非 ASCII 时,ASCII 收尾(rendererAsciiOutput)按原样保留它,整份 chunk 因此仍按
// 双字节常驻。助理的几个 hook 脚本以 String.raw 写成:文案与正则放在 raw 段外插值进去(#655 的余项,main.js 约 3.6 MB)。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { parseAst } from 'vite'
import { describe, expect, it } from 'vitest'
import { taggedTemplateNonAsciiRanges } from '../../../scripts/build/renderer-chunking.mts'

describe('助理 hook 脚本的 String.raw 段只含 ASCII', () => {
  for (const name of ['note', 'pending', 'panel', 'resource']) {
    it(`assistant-${name}-hook.ts`, () => {
      const file = join(import.meta.dirname, '../../../apps/desktop/electron/sessionpage', `assistant-${name}-hook.ts`)
      const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm' }).code
      expect(taggedTemplateNonAsciiRanges(parseAst(js))).toEqual([])
    })
  }
})
