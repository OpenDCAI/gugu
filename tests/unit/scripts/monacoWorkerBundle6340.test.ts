import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { rewriteMonacoWorkerFallback } from '../../../scripts/build/monaco-worker-bundle.mjs'

const require = createRequire(import.meta.url)
const monacoEsm = path.join(path.dirname(require.resolve('monaco-editor/package.json')), 'esm')

// @@@6340 判据喂的是**已装的** monaco 源文件:monaco 升级改了兜底那行,这里先红,而不是构建悄悄退回双份 worker 打包。
describe('monaco worker single bundle (#6340)', () => {
  test.each([
    ['css', 'css'],
    ['html', 'html'],
    ['json', 'json'],
    ['typescript', 'ts'],
  ])('rewrites the installed %s workerManager fallback to the shared ?worker module', (lang, worker) => {
    const code = fs.readFileSync(path.join(monacoEsm, 'vs/language', lang, 'workerManager.js'), 'utf8')
    const result = rewriteMonacoWorkerFallback(code)
    expect(result.rewrites).toBe(1)
    expect(result.code).toContain(`import __guguMonacoWorker_${worker} from './${worker}.worker.js?worker';`)
    expect(result.code).toContain(`createWorker: () => new __guguMonacoWorker_${worker}()`)
    expect(result.code).not.toContain('new URL(')
  })

  test('leaves code without the fallback untouched (negative control)', () => {
    const code = "const w = new Worker(new URL('./other.js', import.meta.url))\n"
    expect(rewriteMonacoWorkerFallback(code)).toEqual({ code, rewrites: 0 })
  })
})
