// 本机会话索引（sessionIndex）：会话页导入面板的数据源。
// 关心的行为：分轮解析（时间预算）、跨进程缓存复用、变更/删除对账、引擎与关键词筛选。
// 真实文件 fixture（tmpdir），非 mock 解析——解析口径必须和真 transcript 一致。
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalSessionIndex } from '@gugu/core/local/agent/sessionIndex'
import type {
  LocalSessionIndex,
  LocalSessionIndexOptions,
} from '@gugu/core/local/agent/sessionIndex'

const cleanups: string[] = []
const indexes: LocalSessionIndex[] = []

afterEach(async () => {
  // 先等后台落盘停下来再删目录。readPage 不等落盘就返回（见 flush 的注释），
  // 直接 rmSync 会与那次写抢同一个目录 —— 在 mac1 CI 上实测报
  // `ENOTEMPTY … syscall: 'rm'`（dev@9ed8536c7 的 Unit tests 2/2 因此翻红）。
  for (const index of indexes.splice(0)) await index.flush()
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 建索引一律走这里：注册进 indexes，teardown 才等得到它的落盘。 */
function makeIndex(options: LocalSessionIndexOptions): LocalSessionIndex {
  const index = createLocalSessionIndex(options)
  indexes.push(index)
  return index
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'gugu-session-index-'))
  cleanups.push(home)
  return home
}

function jsonl(lines: Array<Record<string, unknown>>): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

function writeAt(path: string, content: string, mtimeSec: number): void {
  writeFileSync(path, content)
  utimesSync(path, mtimeSec, mtimeSec)
}

function writeClaude(
  home: string,
  opts: { providerSessionId: string; text: string; cwd: string; mtimeSec: number },
): string {
  const dir = join(home, '.claude', 'projects', '-fixture')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${opts.providerSessionId}.jsonl`)
  writeAt(
    path,
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: opts.text },
        sessionId: opts.providerSessionId,
        cwd: opts.cwd,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
        sessionId: opts.providerSessionId,
        cwd: opts.cwd,
      },
    ]),
    opts.mtimeSec,
  )
  return path
}

function writeCodex(
  home: string,
  opts: { providerSessionId: string; text: string; cwd: string; mtimeSec: number },
): string {
  const dir = join(home, '.codex', 'sessions', '2026', '07', '30')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-07-30T00-00-00-${opts.providerSessionId}.jsonl`)
  writeAt(
    path,
    jsonl([
      { type: 'session_meta', payload: { id: opts.providerSessionId, cwd: opts.cwd } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: opts.text }] },
      },
    ]),
    opts.mtimeSec,
  )
  return path
}

/** 一个既有 claude 又有 codex 会话的本机环境；codex 那条更新更晚。 */
function seedBoth(home: string): void {
  writeClaude(home, {
    providerSessionId: 'claude-1',
    text: '帮我把登录页的主按钮 hover 态改成设计稿的颜色',
    cwd: '/work/webapp',
    mtimeSec: 1_000_100,
  })
  writeCodex(home, {
    providerSessionId: 'codex-1',
    text: '给结算服务补一个幂等键，避免重复扣款',
    cwd: '/work/billing',
    mtimeSec: 1_000_200,
  })
}

const indexOptions = (home: string, cacheFilePath?: string) => ({
  // 原生配置根由宿主按插件的 nativeHome 算好递进来;这里直接给默认那一份。
  nativeHomes: { 'claude-code': [join(home, '.claude')], codex: [join(home, '.codex')] },
  cacheFilePath,
  rescanIntervalMs: 0,
})

describe('createLocalSessionIndex', () => {
  describe('清单', () => {
    it('两个引擎的会话都列出来，按最近更新倒序', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage()

      expect(page.rows.map((row) => row.providerSessionId)).toEqual(['codex-1', 'claude-1'])
      expect(page.rows[0].cwd).toBe('/work/billing')
      expect(page.countsBySource).toEqual({ 'claude-code': 1, codex: 1 })
    })

    it('按引擎筛选时只返回该引擎的会话', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage({
        source: 'claude-code',
      })

      expect(page.rows).toHaveLength(1)
      expect(page.rows[0].source).toBe('claude-code')
    })

    it('本机没有任何会话时返回空页而不是报错', async () => {
      const page = await makeIndex(indexOptions(makeHome())).readPage()

      expect(page.rows).toEqual([])
      expect(page.discovered).toBe(0)
      expect(page.pending).toBe(0)
    })

    it('limit 只截断返回条数，matched 仍是命中总数', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage({ limit: 1 })

      expect(page.rows).toHaveLength(1)
      expect(page.matched).toBe(2)
    })
  })

  describe('搜索', () => {
    it('关键词匹配标题，大小写不敏感', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage({ query: '幂等键' })

      expect(page.rows.map((row) => row.providerSessionId)).toEqual(['codex-1'])
    })

    it('关键词也匹配会话所在文件夹', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage({ query: 'webapp' })

      expect(page.rows.map((row) => row.providerSessionId)).toEqual(['claude-1'])
    })

    it('多个词要全部命中才算匹配', async () => {
      const home = makeHome()
      seedBoth(home)
      const index = makeIndex(indexOptions(home))

      const both = await index.readPage({ query: '登录页 hover' })
      const mixed = await index.readPage({ query: '登录页 幂等键' })

      expect(both.rows).toHaveLength(1)
      expect(mixed.rows).toHaveLength(0)
    })
  })

  describe('分轮解析', () => {
    it('时间预算用完就先返回，未解析的计入 pending', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(indexOptions(home)).readPage({
        hydrateBudgetMs: 0,
      })

      expect(page.rows).toEqual([])
      expect(page.discovered).toBe(2)
      expect(page.pending).toBe(2)
    })

    it('再调一轮会把剩下的解析完，pending 归零', async () => {
      const home = makeHome()
      seedBoth(home)
      const index = makeIndex(indexOptions(home))

      await index.readPage({ hydrateBudgetMs: 0 })
      const second = await index.readPage()

      expect(second.pending).toBe(0)
      expect(second.rows).toHaveLength(2)
    })

    it('没有真实对话的文件不进清单，但也不会每轮重读', async () => {
      const home = makeHome()
      seedBoth(home)
      const dir = join(home, '.claude', 'projects', '-fixture')
      // 纯命令记录：Claude 把斜杠命令也写进 transcript，这类文件导入了也没有内容。
      writeAt(
        join(dir, 'command-only.jsonl'),
        jsonl([
          {
            type: 'user',
            message: { role: 'user', content: '<command-name>/clear</command-name>' },
            sessionId: 'command-only',
            cwd: '/work/webapp',
          },
        ]),
        1_000_300,
      )

      const page = await makeIndex(indexOptions(home)).readPage()

      expect(page.rows.map((row) => row.providerSessionId)).not.toContain('command-only')
      expect(page.discovered).toBe(3)
      expect(page.pending).toBe(0)
    })
  })

  describe('缓存', () => {
    it('没索引过时缓存页是空的，且不谎称自己是缓存结果', async () => {
      const home = makeHome()
      seedBoth(home)

      const page = await makeIndex(
        indexOptions(home, join(home, 'index.json')),
      ).readCachedPage()

      expect(page.rows).toEqual([])
      expect(page.stale).toBe(false)
    })

    it('索引过之后，新起的实例不扫盘就能出同一份清单', async () => {
      const home = makeHome()
      seedBoth(home)
      const cacheFilePath = join(home, 'index.json')
      const writer = makeIndex(indexOptions(home, cacheFilePath))
      await writer.readPage()
      // 落盘是后台进行的，等它写完再换实例读。
      // ❌ 别退回 `setTimeout(50)`：写超过 50ms 就假红，本身也是抖动源。
      await writer.flush()

      const cached = await makeIndex(indexOptions(home, cacheFilePath)).readCachedPage()

      expect(cached.rows.map((row) => row.providerSessionId)).toEqual(['codex-1', 'claude-1'])
      expect(cached.stale).toBe(true)
    })

    it('会话内容变了就重新解析，标题跟着变', async () => {
      const home = makeHome()
      seedBoth(home)
      const cacheFilePath = join(home, 'index.json')
      const index = makeIndex(indexOptions(home, cacheFilePath))
      await index.readPage()

      writeClaude(home, {
        providerSessionId: 'claude-1',
        text: '换个话题：把构建脚本迁到 esbuild',
        cwd: '/work/webapp',
        mtimeSec: 1_000_400,
      })
      const page = await index.readPage({ source: 'claude-code' })

      expect(page.rows[0].title).toContain('esbuild')
    })

    it('readPage 返回时落盘还没完成，flush 之后才保证写完', async () => {
      const home = makeHome()
      seedBoth(home)
      const cacheFilePath = join(home, 'index.json')
      const index = makeIndex(indexOptions(home, cacheFilePath))

      await index.readPage()
      // 读不该被磁盘写阻塞 —— 所以这一刻缓存文件本来就还不在。
      const landedBeforeFlush = existsSync(cacheFilePath)

      await index.flush()

      // 这条断言故意钉住「异步落盘」这个前提：它一旦翻成 true，说明落盘改同步了，
      // 那 flush 是否还有必要、teardown 的等待是否还需要，都该重新评估——而不是顺手把它改绿。
      expect(landedBeforeFlush).toBe(false)
      expect(existsSync(cacheFilePath)).toBe(true)
      // 落盘走 tmp + rename，flush 之后不该留下半成品。
      expect(existsSync(`${cacheFilePath}.tmp`)).toBe(false)
    })

    it('会话文件被删掉后，对账过的清单里不再出现', async () => {
      const home = makeHome()
      seedBoth(home)
      const claudePath = writeClaude(home, {
        providerSessionId: 'claude-2',
        text: '临时会话',
        cwd: '/work/tmp',
        mtimeSec: 1_000_500,
      })
      const index = makeIndex(indexOptions(home))
      await index.readPage()

      rmSync(claudePath)
      const page = await index.readPage()

      expect(page.rows.map((row) => row.providerSessionId)).not.toContain('claude-2')
    })
  })
})
