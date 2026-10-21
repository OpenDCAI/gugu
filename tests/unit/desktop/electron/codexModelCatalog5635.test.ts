import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW,
  codexModelCatalog,
  memoizeSuccess,
  platformModelFacts,
  writeCodexModelCatalog,
} from '../../../../apps/desktop/electron/runtime/codex-model-catalog.mjs'
import {
  CODEX_GENERIC_BASE_INSTRUCTIONS,
  CODEX_GENERIC_BASE_INSTRUCTIONS_SHA256,
} from '../../../../apps/desktop/electron/runtime/codex-generic-base-instructions.mjs'
import { codexPlatformModelFacts } from '../../../../packages/session-plugins/src/agents/impl/codex/platform-models'

/**
 * #5635 codex 对网关别名的元数据:从网关目录的事实渲染,其余字段逐项沿用 codex 自己的 fallback。
 * 真 codex(0.147.0 / 0.153.4)对这份文件的 `codex debug models` 读数见 issue 回帖;这里只钉形状。
 */
describe('codex model catalog for platform models (#5635)', () => {
  const facts = platformModelFacts(JSON.stringify([
    { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, efforts: ['low', 'high', 'max'] },
  ]))

  test('gateway facts become the entry; everything else is codex fallback descriptor', () => {
    const [entry] = codexModelCatalog(facts, []).models
    expect(entry).toMatchObject({
      slug: 'glm-5.3',
      display_name: 'GLM-5.3',
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      visibility: 'list',
      supported_in_api: true,
      shell_type: 'default',
      apply_patch_tool_type: null,
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      supports_parallel_tool_calls: false,
    })
    expect((entry!.supported_reasoning_levels).map((level) => level.effort)).toEqual(['low', 'high', 'max'])
    expect(entry!.base_instructions).toBe(CODEX_GENERIC_BASE_INSTRUCTIONS)
  })

  test('a model codex already knows keeps codex\'s own entry (longest prefix, as codex looks it up)', () => {
    const bundled = [
      { slug: 'gpt-5', base_instructions: 'five', context_window: 1 },
      { slug: 'gpt-5.5', base_instructions: 'five-five', context_window: 272_000, visibility: 'hide', priority: 7 },
    ]
    const [entry] = codexModelCatalog(platformModelFacts(JSON.stringify([
      { id: 'gpt-5.5-2026', displayName: 'GPT-5.5', contextWindow: 272_000, efforts: ['low'] },
    ])), bundled).models
    expect(entry).toMatchObject({
      slug: 'gpt-5.5-2026',
      base_instructions: 'five-five',
      visibility: 'list',
      supported_in_api: true,
      priority: 0,
    })
  })

  test('the carried instructions are codex prompt.md byte for byte', () => {
    expect(createHash('sha256').update(CODEX_GENERIC_BASE_INSTRUCTIONS).digest('hex'))
      .toBe(CODEX_GENERIC_BASE_INSTRUCTIONS_SHA256)
    expect(CODEX_GENERIC_BASE_INSTRUCTIONS.startsWith('You are a coding agent running in the Codex CLI')).toBe(true)
  })

  test.each([
    ['not JSON', 'nope', /not JSON/],
    ['empty', '[]', /non-empty array/],
    ['bad window', JSON.stringify([{ id: 'm', contextWindow: -1, efforts: ['low'] }]), /'m' has an invalid contextWindow -1/],
    ['no efforts field', JSON.stringify([{ id: 'm', contextWindow: 1 }]), /'m' has malformed reasoning efforts undefined/],
    ['blank effort', JSON.stringify([{ id: 'm', contextWindow: 1, efforts: ['low', ' '] }]), /'m' has malformed reasoning efforts/],
    ['duplicate', JSON.stringify([{ id: 'm', contextWindow: 1, efforts: ['low'] }, { id: 'm', contextWindow: 1, efforts: ['low'] }]), /duplicate id 'm'/],
  ])('fails loud on a broken payload: %s', (_name, raw, message) => {
    expect(() => platformModelFacts(raw)).toThrow(message)
  })

  test('a model whose directory row has no window gets codex\'s own unknown-model window, never none', () => {
    const [entry] = codexModelCatalog(platformModelFacts(JSON.stringify([
      { id: 'm', displayName: 'M', contextWindow: null, efforts: ['low'] },
    ])), []).models
    expect([entry!.context_window, entry!.max_context_window]).toEqual([
      CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW,
      CODEX_UNKNOWN_MODEL_CONTEXT_WINDOW,
    ])
  })

  test('facts: the switchable set, the session model included, each model with its OWN directory efforts (#6447)', () => {
    expect(JSON.parse(codexPlatformModelFacts({
      model: 'glm-5.3',
      contextWindow: 1_000_000,
      reasoningEfforts: ['low', 'high', 'max'],
      models: [
        { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, reasoningEfforts: [] },
        { id: 'qwen3.8-max-0902', displayName: 'Qwen3.8 Max', contextWindow: 1_000_000, reasoningEfforts: null },
      ],
    }))).toEqual([
      { id: 'glm-5.3', displayName: 'glm-5.3', contextWindow: 1_000_000, efforts: ['low', 'high', 'max'] },
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      // `[]` (目录说没有这根轴)与 null(目录还没这条事实)都是「codex 不给档位」—— ❌ 不拿全局表补。
      { id: 'minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, efforts: [] },
      { id: 'qwen3.8-max-0902', displayName: 'Qwen3.8 Max', contextWindow: 1_000_000, efforts: [] },
    ])
  })

  test('facts keep only levels codex itself names — one unknown name would make codex reject the whole catalog', () => {
    expect(JSON.parse(codexPlatformModelFacts({
      model: 'gpt-5.6-sol',
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'auto', 'High'],
    }))[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('a model the directory gives no efforts renders with no reasoning levels, not a failure', () => {
    const [entry] = codexModelCatalog(platformModelFacts(JSON.stringify([
      { id: 'minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, efforts: [] },
    ])), []).models
    expect(entry!.supported_reasoning_levels).toEqual([])
  })

  test('facts: a switchable entry of the session model without its own window takes the session window', () => {
    expect(JSON.parse(codexPlatformModelFacts({
      model: 'glm-5.3',
      contextWindow: 1_000_000,
      reasoningEfforts: ['low', 'high', 'max'],
      models: [{ id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: null, reasoningEfforts: null }],
    }))[0]).toMatchObject({ id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, efforts: ['low', 'high', 'max'] })
  })
})

/**
 * The bridge's side of #5635, at the one boundary it calls (`writeCodexModelCatalog`): what app-server
 * is pointed at, and the file's lifetime. (The end-to-end bridge run lived in a suite #6177 retired;
 * the argv was read on the real product in #5635's B.)
 */
describe('codex bridge catalog file (#5635)', () => {
  const FACTS = JSON.stringify([
    { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'] },
  ])
  const bundled = async () => JSON.stringify({ models: [] })
  const pathOf = (args: string[]) => JSON.parse(args[1]!.slice('model_catalog_json='.length)) as string

  test('facts ⇒ app-server gets `-c model_catalog_json=<file>`; dispose removes the file', async () => {
    const written = await writeCodexModelCatalog({ GUGU_PLATFORM_MODELS: FACTS }, bundled)
    expect(written.args[0]).toBe('-c')
    const file = pathOf(written.args)
    const catalog = JSON.parse(readFileSync(file, 'utf8')) as { models: Array<{ slug: string; context_window: number }> }
    expect(catalog.models.map((m) => [m.slug, m.context_window])).toEqual([['glm-5.3', 1_000_000]])
    written.dispose()
    expect(existsSync(file)).toBe(false)
  })

  test('[control] no facts (the user\'s own Codex account) ⇒ no file, no args', async () => {
    const written = await writeCodexModelCatalog({}, bundled)
    expect(written.args).toEqual([])
  })

  test('a broken payload or an unreadable bundled catalog fails loud', async () => {
    await expect(writeCodexModelCatalog({ GUGU_PLATFORM_MODELS: '{not json' }, bundled)).rejects.toThrow(/not JSON/)
    await expect(writeCodexModelCatalog({ GUGU_PLATFORM_MODELS: FACTS }, async () => 'garbage')).rejects.toThrow(/升级 Codex/)
  })
})

describe('bundled catalog read is remembered only once it succeeded', () => {
  test('a transient failure is not kept: the next caller reads again and gets the catalog', async () => {
    let reads = 0
    const read = memoizeSuccess(async () => {
      reads += 1
      if (reads === 1) throw new Error('codex debug models: transient failure')
      return '{"models":[]}'
    })
    await expect(read()).rejects.toThrow(/transient failure/)
    await expect(read()).resolves.toBe('{"models":[]}')
    // success is remembered: no third read
    await expect(read()).resolves.toBe('{"models":[]}')
    expect(reads).toBe(2)
  })

  test('callers sharing one in-flight read all see its failure; only then is it forgotten', async () => {
    let reads = 0
    let fail!: (error: Error) => void
    const read = memoizeSuccess(() => {
      reads += 1
      return reads === 1 ? new Promise<string>((_, reject) => { fail = reject }) : Promise.resolve('ok')
    })
    const first = read()
    const second = read()
    expect(reads).toBe(1)
    fail(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
    await expect(read()).resolves.toBe('ok')
    expect(reads).toBe(2)
  })
})
