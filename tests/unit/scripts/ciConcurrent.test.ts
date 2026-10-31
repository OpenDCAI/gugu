import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseJobs, runConcurrent, summarize } from '../../../scripts/ci-concurrent.mts'

// #6270:session-db 把几段互不依赖的测试并到一个 step 里并发跑。并发只能换墙钟,
// ❌ 不能换来更松的判定或更少的信息 —— 这几条钉的就是这个。
describe('ci-concurrent', () => {
  test('一条红 ⇒ 整体红,且兄弟照样跑到底(一次报出全部的红)', async () => {
    const lines: string[] = []
    const results = await runConcurrent(
      parseJobs(['bad=echo boom; exit 3', 'slow=sleep 0.3; echo done']),
      { write: (line) => lines.push(line) },
    )
    const summary = summarize(results)
    expect(summary.ok).toBe(false)
    expect(summary.failed).toEqual(['bad'])
    expect(results.find((r) => r.label === 'bad')?.code).toBe(3)
    expect(lines).toContain('[slow] done\n')
    expect(lines).toContain('[bad] boom\n')
  })

  test('真的并发:两条各等对方到场,串着跑的话第一条永远等不到', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-concurrent-'))
    try {
      const meet = (self: string, other: string) => `${self}=touch '${dir}/${self}'; while [ ! -e '${dir}/${other}' ]; do sleep 0.05; done`
      const results = await runConcurrent(parseJobs([meet('a', 'b'), meet('b', 'a')]), { write: () => {} })
      expect(summarize(results).ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('管道中段失败也算红(pipefail),不被 tail 之类洗白', async () => {
    const results = await runConcurrent(parseJobs(['p=false | cat']), { write: () => {} })
    expect(summarize(results).ok).toBe(false)
  })

  test('参数形状错就当场报,不静默少跑一条', () => {
    expect(() => parseJobs([])).toThrow()
    expect(() => parseJobs(['no-equals'])).toThrow()
    expect(() => parseJobs(['a=true', 'a=true'])).toThrow()
  })
})
