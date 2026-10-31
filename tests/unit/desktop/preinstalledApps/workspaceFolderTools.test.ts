// 群文件夹 App 给 agent 的文件夹工具(群文件夹工具搬进 App,2026-10-11):
// list / read / create / edit / delete,经 catalog 叫 workspace__<tool>。每个工具只用 gugu.files 和 Node 自带的模块;
// 交来的群、交来的文件在网关按调用的 agent 本人核过,所以每个 chat_id / item_id 都必须标 format、标在顶层(方案 R5,
// PR-1 评审第 3 条)。程序的 gugu 换成假的,跑的是真的 tools.js / folder.mjs。父提交上没有 folder.mjs,这些格全红。
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HANDED_CHAT_FORMAT, handedIds } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-programs'
import { expectedVersionOf, replacedSinceError } from '../../../../apps/desktop/src/session/shared/extensions/app-files-core'
import { savedFileName } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { guguLink, linkTargetOf } from '@gugu/core/shared/ui/guguLink'

const appDir = resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace')
type Tool = { description: string; inputSchema: { type: string; required?: string[]; properties: Record<string, Record<string, unknown>> }; run: (args: Record<string, unknown>, call?: { agent?: string }) => Promise<unknown> }
const tools = async () => (await import(/* @vite-ignore */ resolve(appDir, 'tools.js'))) as Record<string, Tool>
const folder = async () =>
  (await import(/* @vite-ignore */ resolve(appDir, 'folder.mjs'))) as { pageOf: (text: string, head: object, page?: { offset?: number; limit?: number }) => string; localFileName: (name: string) => string }

const CHAT = '33333333-3333-4333-8333-333333333333'
const DOC = '0d000000-0000-4000-8000-000000000001'
const SHEET = '0d000000-0000-4000-8000-000000000002'
const PDF = '0d000000-0000-4000-8000-000000000003'
const MESSAGE = '55555555-5555-4555-8555-555555555555'
const by = { id: 'user:22222222-2222-4222-8222-222222222222', name: 'Kip', kind: 'agent' }
const entry = (id: string, name: string, type: string, more: Record<string, unknown> = {}) => {
  const file = {
    id, chat: CHAT, name, type, contentType: type === 'json' ? 'application/json' : type === 'binary' ? 'application/pdf' : 'text/markdown',
    size: 10, version: 1, createdBy: by, updatedAt: '2026-10-11T00:00:00Z', sourceMessageIds: [], ...more,
  }
  return { ...file, savedName: savedFileName(file) }
}
const ENTRIES: ReturnType<typeof entry>[] = []
/** The agents calling, as the gateway stamps them (`_meta['gugu/agent']`); each saves under its own folder. */
const AGENT = 'user:0a000000-0000-4000-8000-0000000000a1'
const OTHER_AGENT = 'user:0a000000-0000-4000-8000-0000000000a2'
const savedIn = (agent: string, id: string, version: number) => join(tmpdir(), 'gugu-workspace', agent.slice('user:'.length), id, `v${version}`)

let texts: Record<string, string>
const calls: unknown[][] = []
const closed: string[] = []
// As an App sees a refusal: its code and, where it says which one, `detail.reason` (bridge-protocol.ts `ErrorDetail`).
const coded = (code: string, message: string, reason?: string) => Object.assign(new Error(message), { code, ...(reason ? { detail: { reason } } : {}) })

function handle(id: string) {
  const e = ENTRIES.find((candidate) => candidate.id === id)
  if (!e) throw coded('not-found', 'No such file in a chat you are in')
  const close = () => closed.push(id)
  if (e.type === 'binary') return { entry: e, type: 'binary', blob: async () => new Blob([new Uint8Array([1, 2, 3])]), close }
  return {
    entry: e,
    type: e.type,
    get text() { return texts[id]! },
    edit(old: string, next: string) {
      calls.push(['edit', id, old, next])
      const at = texts[id]!.indexOf(old)
      if (at < 0) throw coded('content-changed', 'old is not in the file (it changed, or it does not match exactly)', 'old-not-found')
      if (texts[id]!.indexOf(old, at + 1) >= 0) throw coded('ambiguous', 'old matches more than once; include more context', 'old-matches-many')
      texts[id] = texts[id]!.slice(0, at) + next + texts[id]!.slice(at + old.length)
    },
    close,
  }
}

beforeEach(() => {
  ENTRIES.splice(0, ENTRIES.length, entry(DOC, 'notes [v2].md', 'text'), entry(SHEET, 'prices.json', 'json'), entry(PDF, 'deck.pdf', 'binary'))
  texts = { [DOC]: '# Notes\n\n## One\nfirst\n\n## Two\nsecond\n', [SHEET]: '{\n  "widget": 12\n}' }
  calls.length = 0
  closed.length = 0
  vi.stubGlobal('gugu', {
    linkTo: async (args: Record<string, unknown>) => guguLink(linkTargetOf(args, { id: 'workspace', contributes: { tabs: [{ name: 'main' }] } })),
    files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
      list: async (place: unknown) => (calls.push(['list', place]), ENTRIES),
      open: async (ref: { id: string }, options?: unknown) => (calls.push(['open', ref, options ?? {}]), handle(ref.id)),
      upload: async (place: unknown, file: File, options: unknown) => {
        calls.push(['upload', place, file.name, file.type, await file.text(), options])
        const binary = file.name.endsWith('.bin')
        return [entry('0d000000-0000-4000-8000-00000000000a', file.name, binary ? 'binary' : 'text', binary ? { contentType: 'application/octet-stream' } : {})]
      },
      rename: async (ref: unknown, name: string) => (calls.push(['rename', ref, name]), entry(DOC, name, 'text')),
      // The folder's own version check (app-files-core, #7174), its functions not a copy of them; the fake only knows
      // which version the file is at. In the order files.replace asks: a version first, then the kind of file.
      replace: async (ref: { id: string }, blob: Blob, options?: { expectedVersion?: number }) => {
        calls.push(['replace', ref, new Uint8Array(await blob.arrayBuffer()), options])
        const expected = expectedVersionOf(options?.expectedVersion)
        if (ref.id === DOC) throw coded('invalid', 'notes.md is a live text file: change it through files.open, it is never replaced', 'live-text-file')
        const pdf = ENTRIES.find((candidate) => candidate.id === PDF)!
        if (pdf.version !== expected) throw replacedSinceError(pdf.name, pdf.version, expected)
        pdf.version += 1
        return { ...pdf }
      },
      remove: async (ref: unknown) => calls.push(['remove', ref]),
    },
  })
})

describe('the folder\'s tools as tools.js gives them', () => {
  // R5 / PR-1 评审第 3 条:没标 format 的 chat_id / item_id 让程序退回人的身份(#6492 的泄漏形状)。标在顶层才算数。
  test('every chat_id is a handed chat and every item_id a handed file, on the tool\'s own parameters — never nested', async () => {
    const all = await tools()
    expect(Object.keys(all).sort()).toEqual(['create', 'delete', 'edit', 'list', 'read'])
    const nested = (schema: unknown): string[] => {
      if (!schema || typeof schema !== 'object') return []
      const props = (schema as { properties?: Record<string, unknown>; items?: unknown }).properties ?? {}
      return [
        ...Object.keys(props).filter((key) => key === 'chat_id' || key === 'item_id'),
        ...Object.values(props).flatMap(nested),
        ...nested((schema as { items?: unknown }).items),
      ]
    }
    for (const [name, tool] of Object.entries(all)) {
      const props = tool.inputSchema.properties
      expect(tool.inputSchema.type, name).toBe('object')
      expect('chat_id' in props || 'item_id' in props, `${name} names its chat or file`).toBe(true)
      if (props.chat_id) expect(props.chat_id, name).toMatchObject({ type: 'string', format: 'gugu-chat' })
      if (props.item_id) expect(props.item_id, name).toMatchObject({ type: 'string', format: 'gugu-file' })
      expect(tool.inputSchema.required, name).toContain(props.chat_id ? 'chat_id' : 'item_id')
      for (const [key, value] of Object.entries(props)) expect(nested(value), `${name}.${key} hides a chat or a file inside`).toEqual([])
    }
  })

  test('list: newest first as the folder gives them, with counts, a window, names filtered, links whole', async () => {
    const { list } = await tools()
    const all = (await list!.run({ chat_id: CHAT })) as Record<string, unknown> & { items: Record<string, unknown>[] }
    expect(calls[0]).toEqual(['list', { chat: CHAT }])
    expect(all).toMatchObject({ chat_id: CHAT, documents: 2, files: 1, total: 3, rows: '1-3', next: null })
    expect(all.items[0]).toEqual({
      id: DOC, name: 'notes [v2].md', path: undefined, metadata: {}, type: 'text', size: 10, version: 1, by, updated_at: '2026-10-11T00:00:00Z',
      link: `[notes \\[v2\\].md](gugu-file://${DOC})`,
    })
    expect(await list!.run({ chat_id: CHAT, rows: '2' })).toMatchObject({ total: 3, rows: '1-2', next: '3-4' })
    expect(await list!.run({ chat_id: CHAT, rows: '3-4' })).toMatchObject({ rows: '3-3', next: null })
    expect(((await list!.run({ chat_id: CHAT, kind: 'file' })) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([PDF])
    expect(((await list!.run({ chat_id: CHAT, kind: 'document', name: 'PRICE' })) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([SHEET])
    await expect(list!.run({ chat_id: CHAT, rows: 'all' })).rejects.toThrow(/rows takes "20" or "21-40"/)
  })

  // chat_id 的说明请 agent 给「the number people see」:agent 照着传 JSON 数字 211178(A/B 10-12)。那个数要在网关里变成
  // 文字 —— 交出、按 agent 本人核、换成群 id;在程序里才转,就绕开了核(PR-2 评审 605898b,#6492 的泄漏形状)。
  // 真的 handedIds + 这个 App 真的 schema;list 和 create 共用 folder.mjs 的 chatOf,只收文字。
  test('chat_id: the gateway hands a JSON number as its text, checked as the agent; the program takes text only, anything else refused saying what it takes', async () => {
    const { list, create } = await tools()
    for (const tool of [list!, create!]) {
      expect(handedIds(tool as never, { chat_id: 211178 }, HANDED_CHAT_FORMAT)).toEqual(['211178'])
      expect(handedIds(tool as never, { chat_id: '211178' }, HANDED_CHAT_FORMAT)).toEqual(['211178'])
      expect(handedIds(tool as never, { chat_id: CHAT }, HANDED_CHAT_FORMAT)).toEqual([CHAT])
      // Not a whole positive number: named nothing, handed nothing — the program's own check below refuses it.
      for (const bad of [1.5, -3, 0, Number.NaN, Number.MAX_SAFE_INTEGER + 2, true, null]) expect(handedIds(tool as never, { chat_id: bad }, HANDED_CHAT_FORMAT)).toEqual([])
    }
    // Text reaches the folder as given.
    await list!.run({ chat_id: '211178' })
    await create!.run({ chat_id: CHAT, title: 'n.md', content: 'x' })
    expect(calls.map((call) => call.slice(0, 2))).toEqual([['list', { chat: '211178' }], ['upload', { chat: CHAT }]])
    // Not text — a number the gateway did not hand included — refused before the folder is asked.
    const refused = /^chat_id is a chat's id or the number people see \(its 咕咕号\), not /
    for (const bad of [211178, 1.5, -3, 0, Number.NaN, '', null, undefined, true, { chat: CHAT }]) {
      await expect(list!.run({ chat_id: bad })).rejects.toThrow(refused)
      await expect(create!.run({ chat_id: bad, title: 'n.md', content: 'x' })).rejects.toThrow(refused)
    }
    await expect(list!.run({ chat_id: -3 })).rejects.toThrow(/, not -3$/)
    expect(calls).toHaveLength(2)
  })

  test('read: a text file a page at a time — a JSON header, a blank line, its lines verbatim; read-only, closed after', async () => {
    const { read } = await tools()
    const page = String(await read!.run({ item_id: DOC, limit: 3 }))
    const [head, blank, ...body] = page.split('\n')
    expect(blank).toBe('')
    expect(JSON.parse(head!)).toEqual({
      id: DOC, name: 'notes [v2].md', type: 'text', by, updated_at: '2026-10-11T00:00:00Z',
      link: `[notes \\[v2\\].md](gugu-file://${DOC})`, total_lines: 7, lines: '1-3', next_offset: 4,
    })
    expect(body.join('\n')).toBe('# Notes\n\n## One\n')
    expect(calls[0]).toEqual(['open', { id: DOC }, { readOnly: true }])
    expect(closed).toEqual([DOC])
    expect(String(await read!.run({ item_id: SHEET }))).toMatch(/\n\n\{\n {2}"widget": 12\n\}$/)
  })

  test('read: a stored file, or save: true, is saved whole on this computer, in its agent\'s, file\'s and version\'s own folder; path and version come back', async () => {
    const { read } = await tools()
    const saved = (await read!.run({ item_id: PDF }, { agent: AGENT })) as { saved_to: string; version: number }
    expect(saved).toMatchObject({ saved_to: join(savedIn(AGENT, PDF, 1), 'deck.pdf'), version: 1 })
    expect([...readFileSync(saved.saved_to)]).toEqual([1, 2, 3])
    const whole = (await read!.run({ item_id: DOC, save: true }, { agent: AGENT })) as { saved_to: string; version: number }
    expect(whole).toMatchObject({ saved_to: join(savedIn(AGENT, DOC, 1), 'notes [v2].md'), version: 1 })
    expect(readFileSync(whole.saved_to, 'utf8')).toBe(texts[DOC])
    await expect(read!.run({ item_id: '0d000000-0000-4000-8000-0000000000ff' }, { agent: AGENT })).rejects.toThrow(/no file .* in a chat you are in: list shows what is there/)
  })

  test.each([
    [DOC, '周报', 'text', 'text/markdown', '周报.md'],
    [SHEET, '投票', 'json', 'application/json', '投票.json'],
    [PDF, '报告', 'binary', 'application/pdf', '报告.pdf'],
    [PDF, 'photo.jpeg', 'binary', 'image/jpeg', 'photo.jpeg'],
    [PDF, 'archive', 'binary', 'application/octet-stream', 'archive'],
  ] as const)('read: %s named %s saves the host filename for %s (%s)', async (id, name, type, contentType, savedName) => {
    ENTRIES.splice(0, ENTRIES.length, entry(id, name, type, { contentType }))
    const { read } = await tools()
    const saved = (await read!.run({ item_id: id, save: true }, { agent: AGENT })) as { saved_to: string; name: string }
    expect(saved).toMatchObject({ name, saved_to: join(savedIn(AGENT, id, 1), savedName) })
    if (type === 'binary') expect([...readFileSync(saved.saved_to)]).toEqual([1, 2, 3])
    else expect(readFileSync(saved.saved_to, 'utf8')).toBe(texts[id])
    expect(closed).toEqual([id])
  })

  // 10-13(#7174,搬进来):同一台机器上主人的两个 agent 读同一个文件,各拿各的副本 —— 共用一份时,一个的读会冲掉另一个
  // 还没存回的改动,而版本号对得上,检查看不见。没有 agent 的调用拒掉,不退回大家共用的目录(148)。
  test('read: each agent its own copy on this computer; a call with no agent of its own is refused', async () => {
    const { read } = await tools()
    const mine = (await read!.run({ item_id: PDF }, { agent: AGENT })) as { saved_to: string }
    writeFileSync(mine.saved_to, 'agent 1, half way through its change')
    const theirs = (await read!.run({ item_id: PDF }, { agent: OTHER_AGENT })) as { saved_to: string }
    expect(theirs.saved_to).toBe(join(savedIn(OTHER_AGENT, PDF, 1), 'deck.pdf'))
    expect(readFileSync(mine.saved_to, 'utf8')).toBe('agent 1, half way through its change')
    for (const call of [{}, { agent: '' }, { agent: 'user:../shared' }]) {
      await expect(read!.run({ item_id: PDF }, call)).rejects.toThrow('read: only an agent saves into a folder of its own on this computer, and this call names no agent')
    }
    // A text file's page is not saved anywhere: it needs no agent.
    expect(String(await read!.run({ item_id: DOC }))).toMatch(/^\{"id"/)
  })

  // 148(10-13 21:54):一个版本一份。ver 那轮的 Codex 因为从旧版本改起被拒,重新下载盖掉了自己改过的那份,改动没了、原样存回。
  // 现在新版本落在旁边。被拒那次一个字节都没写:第二版的字节是另一个 agent 存的。
  test('one copy per version: an agent refused for starting from a version gone by reads the new one beside the copy it changed', async () => {
    const { read, edit } = await tools()
    const mine = (await read!.run({ item_id: PDF }, { agent: AGENT })) as { saved_to: string; version: number }
    writeFileSync(mine.saved_to, 'my change, made on version 1')
    const theirs = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'deck-theirs.pdf')
    writeFileSync(theirs, 'their change')
    expect(await edit!.run({ item_id: PDF, path: theirs, expected_version: 1 }, { agent: OTHER_AGENT })).toMatchObject({ replaced: PDF, version: 2 })
    const replacements = calls.filter((call) => call[0] === 'replace').length
    await expect(edit!.run({ item_id: PDF, path: mine.saved_to, expected_version: mine.version }, { agent: AGENT }))
      .rejects.toThrow('deck.pdf: you started from version 1, it is version 2 now — someone stored a newer one since you read it, and nothing was written.')
    expect(calls.filter((call) => call[0] === 'replace')).toHaveLength(replacements + 1)
    const again = (await read!.run({ item_id: PDF }, { agent: AGENT })) as { saved_to: string; version: number }
    expect(again).toMatchObject({ saved_to: join(savedIn(AGENT, PDF, 2), 'deck.pdf'), version: 2 })
    expect(readFileSync(mine.saved_to, 'utf8')).toBe('my change, made on version 1')
    expect(readdirSync(join(savedIn(AGENT, PDF, 1), '..'))).toEqual(expect.arrayContaining(['v1', 'v2']))
  })

  test('create with content: a text file — markdown unless it says otherwise, JSON when it is an object; its source messages', async () => {
    const { create } = await tools()
    const made = await create!.run({ chat_id: CHAT, title: '周报', content: '# 周报', source_message_ids: [`msg:${MESSAGE}`] })
    expect(calls.at(-1)).toEqual(['upload', { chat: CHAT }, '周报', 'text/markdown', '# 周报', { sourceMessageIds: [MESSAGE] }])
    expect(made).toMatchObject({ created: { name: '周报', type: 'text' }, stored_as: expect.stringMatching(/^a text file/) })
    await create!.run({ chat_id: CHAT, title: 'state.json', content: '{"votes":{}}' })
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['upload', { chat: CHAT }, 'state.json', 'application/json'])
    await create!.run({ chat_id: CHAT, title: 'report.html', content: '<p>hi</p>' })
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['upload', { chat: CHAT }, 'report.html', ''])
    await expect(create!.run({ chat_id: CHAT, title: 'bad.json', content: '[1]' })).rejects.toThrow(/must be a JSON object at the top/)
    await expect(create!.run({ chat_id: CHAT, content: 'x' })).rejects.toThrow(/needs a title/)
    await expect(create!.run({ chat_id: CHAT, title: 'x.md', content: 'x', path: '/tmp/x' })).rejects.toThrow(/content .* or path .*, one of them/)
    await expect(create!.run({ chat_id: CHAT, title: 'big.md', content: 'y'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/over the 1 MiB/)
  })

  // 同时跑的 A/B(10-12、10-13)里,「种子只在文件名里、正文没有」只出现在参数叫 name 的这一臂(合计 9 比 1,全是 Codex);
  // 对照臂原生的 workspace_create_document 一直叫 title。参数名对齐它(148 10-13)。
  test('create names its file with title, as the native workspace_create_document did — never name', async () => {
    const { create } = await tools()
    const params = Object.keys(create!.inputSchema.properties)
    expect(params).toContain('title')
    expect(params).not.toContain('name')
  })

  test('create with path: the file on this computer as it is, named as on disk unless named', async () => {
    const { create } = await tools()
    const dir = mkdtempSync(join(tmpdir(), 'folder-tools-'))
    const path = join(dir, 'export.bin')
    writeFileSync(path, 'abc')
    const made = await create!.run({ chat_id: CHAT, path })
    expect(calls.at(-1)?.slice(0, 5)).toEqual(['upload', { chat: CHAT }, 'export.bin', '', 'abc'])
    expect(made).toMatchObject({ stored_as: expect.stringMatching(/^stored bytes \(application\/octet-stream\)/) })
    await expect(create!.run({ chat_id: CHAT, path: 'relative.txt' })).rejects.toThrow(/absolute path/)
    await expect(create!.run({ chat_id: CHAT, path: join(dir, 'missing') })).rejects.toThrow(/cannot read/)
  })

  test.each([
    ['季度报告', '季度报告.pdf'],
    ['季度报告.txt', '季度报告.txt'],
    [undefined, 'q3.pdf'],
  ])('create with path: title %s preserves the source suffix as %s unless it has its own', async (title, name) => {
    const { create } = await tools()
    const path = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'q3.pdf')
    writeFileSync(path, 'pdf bytes')
    await create!.run({ chat_id: CHAT, path, title })
    expect(calls.at(-1)?.slice(0, 5)).toEqual(['upload', { chat: CHAT }, name, '', 'pdf bytes'])
  })

  test('edit: old → new on the open file, then closed; what the folder refused, said as the next step', async () => {
    const { edit } = await tools()
    expect(await edit!.run({ item_id: DOC, old: '## Two', new: '## Second' })).toEqual({ edited: DOC })
    expect(texts[DOC]).toContain('## Second\nsecond')
    expect(closed).toEqual([DOC])
    await expect(edit!.run({ item_id: DOC, old: '## Gone', new: 'x' })).rejects.toThrow(/changed since you read it, or old does not match it exactly/)
    await expect(edit!.run({ item_id: DOC, old: '##', new: 'x' })).rejects.toThrow(/matches several places/)
    await expect(edit!.run({ item_id: DOC, old: 'x', new: 'x' })).rejects.toThrow(/the same: nothing to change/)
    await expect(edit!.run({ item_id: PDF, old: 'a', new: 'b' })).rejects.toThrow(/stored file: give its next version as path/)
    await expect(edit!.run({ item_id: DOC, old: 'a', new: 'b', name: 'c.md' })).rejects.toThrow(/edit takes one change/)
  })

  test('edit: name renames it; path with expected_version gives a stored file its next version — a text file is never replaced', async () => {
    const { edit } = await tools()
    expect(await edit!.run({ item_id: DOC, name: ' plan.md ' })).toMatchObject({ renamed: { id: DOC, name: 'plan.md' } })
    expect(calls.at(-1)).toEqual(['rename', { id: DOC }, 'plan.md'])
    const path = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'deck-v2.pdf')
    writeFileSync(path, Buffer.from([9, 8, 7]))
    expect(await edit!.run({ item_id: PDF, path, expected_version: 1 })).toMatchObject({ replaced: PDF, version: 2 })
    expect(calls.at(-1)).toEqual(['replace', { id: PDF }, new Uint8Array([9, 8, 7]), { expectedVersion: 1 }])
    // A version as digits in a string (a bridge that sends every argument as text) is the same number.
    expect(await edit!.run({ item_id: PDF, path, expected_version: '2' })).toMatchObject({ replaced: PDF, version: 3 })
    await expect(edit!.run({ item_id: DOC, path, expected_version: 1 })).rejects.toThrow(/is a text file: change it with old and new/)
  })

  // 存成下一版要说清从哪一版改起(#7174):检查只在 files.replace 那一处 —— folder.mjs 原样交过去,只把它说的话换成 agent
  // 的话。没带版本那次 replace 真被调了(带着 undefined),拒的是文件夹的那一处。
  test('edit with path: no version, or one that is no number, is refused by the folder\'s one check and said as the next step; expected_version without path is refused here', async () => {
    const { edit } = await tools()
    const path = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'deck-v2.pdf')
    writeFileSync(path, Buffer.from([9, 8, 7]))
    await expect(edit!.run({ item_id: PDF, path })).rejects.toThrow('edit with path needs expected_version: the version read gave when it saved the file you changed')
    expect(calls.at(-1)).toEqual(['replace', { id: PDF }, new Uint8Array([9, 8, 7]), { expectedVersion: undefined }])
    for (const bad of ['v1', 1.5]) {
      await expect(edit!.run({ item_id: PDF, path, expected_version: bad })).rejects.toThrow(`expected_version is the version read gave, a whole number, not ${JSON.stringify(bad)}`)
    }
    expect(ENTRIES.find((candidate) => candidate.id === PDF)!.version).toBe(1)
    const asked = calls.length
    await expect(edit!.run({ item_id: DOC, old: 'first', new: 'one', expected_version: 1 })).rejects.toThrow(/expected_version goes with path/)
    await expect(edit!.run({ item_id: DOC, name: 'n.md', expected_version: 1 })).rejects.toThrow(/expected_version goes with path/)
    // expected_version and nothing else: what it goes with, not「edit takes one change」(评审 5afe7e6bc7).
    await expect(edit!.run({ item_id: PDF, expected_version: 1 })).rejects.toThrow(/^expected_version goes with path/)
    expect(calls).toHaveLength(asked)
  })

  test('delete: the file, by its id', async () => {
    const { delete: remove } = await tools()
    expect(await remove!.run({ item_id: PDF })).toEqual({ deleted: PDF })
    expect(calls.at(-1)).toEqual(['remove', { id: PDF }])
  })
})

// 评审 10-13(#7174,随下载搬进来):存到本机的文件名留下原名能留的 —— 各种文字的字母数字照留;只换路径分隔符、Windows
// 不收的字符、控制字符;全是点(`.`、`..`)换成 file;Windows 设备名前加 `_`;结尾的点和空格换成 `_`。
describe('localFileName: a file\'s name on this computer', () => {
  test.each([
    ['中文报表.xlsx', '中文报表.xlsx'],
    ['a/b\\c:d*e?f"g<h>i|j.txt', 'a_b_c_d_e_f_g_h_i_j.txt'],
    ['tab\there\u0007.md', 'tab_here_.md'],
    ['.', 'file'],
    ['..', 'file'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['Lpt1.log', '_Lpt1.log'],
    ['com10.txt', 'com10.txt'],
    ['console.txt', 'console.txt'],
    ['CONIN$', '_CONIN$'],
    ['conout$.log', '_conout$.log'],
    ['report.', 'report_'],
    ['report ', 'report_'],
    ['季度报告. ', '季度报告__'],
  ])('%j is %j', async (name, local) => {
    const { localFileName } = await folder()
    expect(localFileName(name)).toBe(local)
  })

  // 148(10-13):超过 200 字节从主干按字符边界截,❌ 截进一个汉字的字节中间;扩展名留着。
  test('a long Chinese name is cut to 200 bytes on a character boundary, keeping .xlsx', async () => {
    const { localFileName } = await folder()
    // one ASCII byte first: a cut at 200 bytes counted as bytes would land inside a character
    const local = localFileName(`Q${'季度预算'.repeat(30)}.xlsx`)
    expect(Buffer.byteLength(local)).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(local)).toBeGreaterThan(190)
    expect(local).toMatch(/^Q(季度预算)+(季|季度|季度预)?\.xlsx$/)
    expect(local).not.toContain('�')
  })

  test('read saves under it: the name a disk takes, in the version\'s folder', async () => {
    const { read } = await tools()
    Object.assign(ENTRIES.find((candidate) => candidate.id === PDF)!, entry(PDF, 'CON.pdf', 'binary'))
    const saved = (await read!.run({ item_id: PDF }, { agent: AGENT })) as { saved_to: string }
    expect(saved.saved_to).toBe(join(savedIn(AGENT, PDF, 1), '_CON.pdf'))
    expect(readdirSync(savedIn(AGENT, PDF, 1))).toContain('_CON.pdf')
  })
})

describe('pageOf: whole lines, each page under the budget, put back together byte for byte', () => {
  test('a long file pages under 8 000 bytes, next_offset reads on, and the pages make the file', async () => {
    const { pageOf } = await folder()
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(i % 90)}`).join('\n') + '\n'
    let offset: number | null = 1
    let rebuilt = ''
    while (offset !== null) {
      const page = pageOf(text, { id: DOC }, { offset })
      expect(Buffer.byteLength(page, 'utf8')).toBeLessThanOrEqual(8000)
      const cut = page.indexOf('\n\n')
      offset = (JSON.parse(page.slice(0, cut)) as { next_offset: number | null }).next_offset
      rebuilt += page.slice(cut + 2)
    }
    expect(rebuilt).toBe(text)
    expect(() => pageOf(text, {}, { offset: 401 })).toThrow(/past the end: the file has 400 lines/)
    expect(pageOf('', {})).toBe(`${JSON.stringify({ total_lines: 0, lines: null, next_offset: null })}\n\n`)
    const giant = pageOf(`${'y'.repeat(9000)}\nz\n`, {})
    expect(JSON.parse(giant.slice(0, giant.indexOf('\n\n')))).toMatchObject({ lines: '1-1', next_offset: 2, over_budget: true })
  })
})

// 子文件夹 (gugu-supabase 20261016012659): the tools take a folder and say where each file is. Every case here is red on
// the parent commit (no folder, no path, no mkdir/move).
describe('the tools and subfolders', () => {
  const BOX = '0d000000-0000-4000-8000-0000000000f1'
  beforeEach(() => {
    ENTRIES.splice(0, ENTRIES.length,
      entry(BOX, '合同', 'folder', { path: '合同', parentId: null }),
      entry(PDF, 'deck.pdf', 'binary', { path: '合同/deck.pdf', parentId: BOX }),
      entry(DOC, 'notes.md', 'text', { path: 'notes.md', parentId: null }))
    const files = (globalThis as unknown as { gugu: { files: Record<string, unknown> } }).gugu.files
    files.mkdir = async (target: { path: string }) => (calls.push(['mkdir', target]), entry(BOX, target.path.split('/').at(-1)!, 'folder', { path: target.path }))
    files.move = async (ref: { id: string }, to: { folder: string; name?: string }) => {
      calls.push(['move', ref, to])
      if (to.name === 'taken.md') throw coded('name-taken', 'workspace_name_taken: taken.md already exists in this folder')
      const path = [to.folder, to.name].filter(Boolean).join('/')
      return entry(ref.id, to.name ?? 'notes.md', 'text', { path })
    }
    files.open = async (ref: { id: string }, options?: unknown) => {
      calls.push(['open', ref, options ?? {}])
      if (ref.id === BOX) throw coded('invalid', '合同 is a folder: what is in it is listed with files.list({ chat, folder })', 'folder')
      return handle(ref.id)
    }
  })

  test('list says each path, counts folders, and with folder asks for that folder only', async () => {
    const { list } = await tools()
    const all = (await list.run({ chat_id: CHAT })) as { documents: number; files: number; folders: number; items: { path: string; type: string }[] }
    expect(all).toMatchObject({ documents: 1, files: 1, folders: 1 })
    expect(all.items.map((row) => [row.path, row.type])).toEqual([['合同', 'folder'], ['合同/deck.pdf', 'binary'], ['notes.md', 'text']])
    // A folder is listed and entered, never opened: no link to open it with; a file has one.
    expect((all.items as { type: string; link?: string }[]).map((row) => row.type === 'folder' ? 'link' in row : typeof row.link)).toEqual([false, 'string', 'string'])
    expect(calls.at(-1)).toEqual(['list', { chat: CHAT }])
    await list.run({ chat_id: CHAT, folder: '合同' })
    expect(calls.at(-1)).toEqual(['list', { chat: CHAT, folder: '合同' }])
    expect(((await list.run({ chat_id: CHAT, kind: 'folder' })) as { items: { name: string }[] }).items.map((row) => row.name)).toEqual(['合同'])
    await expect(list.run({ chat_id: CHAT, folder: 3 })).rejects.toThrow(/folder is a folder's path/)
  })

  test('create puts a file in a folder; folder alone makes the folder; folder alone with a title is refused', async () => {
    const { create } = await tools()
    await create.run({ chat_id: CHAT, folder: '合同/2026', title: 'plan.md', content: 'x' })
    // A title with a suffix of its own keeps it: the File carries no type (as before).
    expect(calls.at(-1)).toEqual(['upload', { chat: CHAT, folder: '合同/2026' }, 'plan.md', '', 'x', { sourceMessageIds: [] }])
    expect(await create.run({ chat_id: CHAT, folder: '合同/2026' })).toEqual({ created: { id: BOX, name: '2026', path: '合同/2026', type: 'folder' } })
    expect(calls.at(-1)).toEqual(['mkdir', { chat: CHAT, path: '合同/2026' }])
    await expect(create.run({ chat_id: CHAT, folder: '合同/2026', title: 'plan.md' })).rejects.toThrow(/folder alone makes that folder/)
    // Control: neither content, path nor folder is still refused as before.
    await expect(create.run({ chat_id: CHAT, title: 'plan.md' })).rejects.toThrow(/content \(a new text file\) or path/)
  })

  test('edit\'s name with / moves it (a leading / to the top); a name the folder has is said in the agent\'s words', async () => {
    const { edit } = await tools()
    expect(await edit.run({ item_id: DOC, name: '合同/2026/notes.md' })).toMatchObject({ moved: { id: DOC, name: 'notes.md', path: '合同/2026/notes.md' } })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '合同/2026', name: 'notes.md' }])
    await edit.run({ item_id: DOC, name: '/notes.md' })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '', name: 'notes.md' }])
    await expect(edit.run({ item_id: DOC, name: '合同/' })).rejects.toThrow(/ends with \//)
    await expect(edit.run({ item_id: DOC, name: '合同/taken.md' })).rejects.toThrow(/already has a file of that name/)
    // Control: a name without / renames in place, as before.
    await edit.run({ item_id: DOC, name: 'plain.md' })
    expect(calls.at(-1)).toEqual(['rename', { id: DOC }, 'plain.md'])
  })

  test('read on a folder says to list it', async () => {
    const { read } = await tools()
    await expect(read.run({ item_id: BOX })).rejects.toThrow(/is a folder: list it/)
  })
})
