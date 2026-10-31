import { describe, expect, it } from 'vitest'
import { phoneFiles } from '../../../scripts/build/phone-web-dir.mts'

const TASK = 'session-embedded.html'
const dist: Record<string, string> = {
  'index.html': '<script type="module" src="./assets/index-AAAAAAAA.js"></script>',
  [TASK]: '<script type="module" src="./assets/task-BBBBBBBB.js"></script><link href="./assets/task-CCCCCCCC.css">',
  'assets/index-AAAAAAAA.js': 'import"./shared-DDDDDDDD.js";const p=()=>import("./preview-EEEEEEEE.js")',
  'assets/shared-DDDDDDDD.js': 'export const x=1',
  'assets/preview-EEEEEEEE.js': 'new Worker(new URL("pdf.worker-FFFFFFFF.mjs",import.meta.url))',
  'assets/pdf.worker-FFFFFFFF.mjs': '',
  'assets/task-BBBBBBBB.js': 'import"./shared-DDDDDDDD.js";const m=()=>import("./editor.main-GGGGGGGG.js")',
  'assets/editor.main-GGGGGGGG.js': 'new URL("ts.worker-HHHHHHHH.js",import.meta.url)',
  'assets/ts.worker-HHHHHHHH.js': '',
  'assets/task-CCCCCCCC.css': '@font-face{src:url(./devicon-IIIIIIII.ttf)}',
  'assets/devicon-IIIIIIII.ttf': '',
  'assets/app/gugu-icon-512.png': '',
  '_gugu/1/gugu.js': 'import"./chunk-JJJJJJJJ.js"',
  'apps/workspace/index.html': '',
}
const keep = (files = dist) => phoneFiles(Object.keys(files), (f: string) => files[f], TASK)

describe('phone web dir', () => {
  it('drops what only the task entry can reach: its chunks, Monaco behind its dynamic import, its fonts', () => {
    const kept = keep()
    for (const f of [TASK, 'assets/task-BBBBBBBB.js', 'assets/task-CCCCCCCC.css', 'assets/editor.main-GGGGGGGG.js', 'assets/ts.worker-HHHHHHHH.js', 'assets/devicon-IIIIIIII.ttf']) {
      expect(kept.has(f), f).toBe(false)
    }
  })

  it('keeps everything the phone can name: static and dynamic imports, worker URLs, chunks shared with the task entry, public files, Apps', () => {
    const kept = keep()
    for (const f of ['index.html', 'assets/index-AAAAAAAA.js', 'assets/shared-DDDDDDDD.js', 'assets/preview-EEEEEEEE.js', 'assets/pdf.worker-FFFFFFFF.mjs', 'assets/app/gugu-icon-512.png', '_gugu/1/gugu.js', 'apps/workspace/index.html']) {
      expect(kept.has(f), f).toBe(true)
    }
  })

  it('a task-only file that the phone side names is kept (the rule follows references, not names)', () => {
    expect(keep({ ...dist, 'assets/index-AAAAAAAA.js': dist['assets/index-AAAAAAAA.js'] + ';import("./editor.main-GGGGGGGG.js")' }).has('assets/ts.worker-HHHHHHHH.js')).toBe(true)
  })

  it('fails loudly when the build no longer has the task entry', () => {
    const { [TASK]: _task, ...rest } = dist
    expect(() => keep(rest)).toThrow(/任务页入口/)
  })
})
