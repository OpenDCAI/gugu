// Vitest project: gugu.
//
// 「导入外部历史」这一维的**接缝对账**。
//
// 从前 claude 与 codex 是硬编码在 transcriptInventory.ts 里的一对三元表达式；现在引擎特有的
// 部分收敛成了 `transcriptSources/` 下的 spec。但一家引擎要真的能被导入，牵动的**不止**那份
// spec —— 沿路还有四处清单，它们分属两棵互不 import 的依赖树，tsc 只钉得住其中一半。
// 这个文件把剩下那一半变成会红的判据。
//
// ⚠️ 这些不是「多余的重复检查」：每一条对应一种**不会崩、只会静默错**的漏改。
//   · 少一份 spec        → tsc 红（registry 是 Record<TranscriptSource, …>），不用测
//   · 少一个 provider 映射 → 导入时拿到 undefined provider，会话建出来连不上引擎
//   · 少一个 label        → 面板筛选里少一档，用户以为「这家没有历史」
//   · 插件声明了 native、core 没接 → 就是 #3813 要挡的「声明了做不到」
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginRegistry, requireNativeHome } from '@gugu/session-plugins/agents'
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers'
import { resolveSessionCoexistence } from '@gugu/session-core/agents/plugins'
import { TRANSCRIPT_SOURCE_IDS } from '@gugu/core/shared/types/transcripts'
import type { TranscriptSource } from '@gugu/core/shared/types/transcripts'
import { listLocalTranscriptFiles, readLocalTranscript } from '@gugu/core/local/agent/transcriptInventory'
import { transcriptScanOptions } from '../../../../apps/desktop/electron/sessionpage/local-session-source'
import { codexTranscriptSource, isCodexSubagent } from '@gugu/core/local/agent/transcriptSources/codex'
import {
  TRANSCRIPT_SOURCE_SPECS,
  allTranscriptSourceSpecs,
  requireTranscriptSourceSpec,
} from '@gugu/core/local/agent/transcriptSources'
import {
  LOCAL_SESSION_ENGINE_LABEL,
  LOCAL_SESSION_ENGINE_PROVIDER,
} from '@/session/shared/core/session-import/session-import'

const ids = [...TRANSCRIPT_SOURCE_IDS].sort()

describe('transcript source registry', () => {
  it('每个已接通的来源都有一份 spec，且 spec 自报的 id 与注册键一致', () => {
    expect(Object.keys(TRANSCRIPT_SOURCE_SPECS).sort()).toEqual(ids)
    // 注册键与 spec.id 写岔了不会崩：清单会按注册键归类、围栏却按 spec.id 取扫描根，
    // 表现是「列得出来、点开说路径不在允许目录内」。
    for (const [key, spec] of Object.entries(TRANSCRIPT_SOURCE_SPECS)) {
      expect(spec.id, `${key} 的 spec.id 与注册键不一致`).toBe(key)
    }
    expect(allTranscriptSourceSpecs().map((spec) => spec.id)).toEqual([...TRANSCRIPT_SOURCE_IDS])
  })

  it('认不出的来源抛错，而不是回退到某一家', () => {
    // 这个参数经 IPC 从渲染层进来（electron/main.ts 的 `source as TranscriptSource` 只是断言）。
    // 从前的三元表达式把任何非 'claude-code' 的值都当 codex 处理，报出来的是「路径不在允许的
    // 扫描目录内」——离真因十万八千里。
    expect(() => requireTranscriptSourceSpec('nope' as never)).toThrow('未接通的 transcript 来源')
  })

  it('每份 spec 声明的存法都是通用层实现了的（今天只有 jsonl）', () => {
    for (const spec of allTranscriptSourceSpecs()) {
      expect(spec.channel, `${spec.id}`).toBe('jsonl')
      expect(spec.fileExtension.startsWith('.'), `${spec.id} 的 fileExtension 要带点`).toBe(true)
    }
  })
})

describe('路径围栏挡得住符号链接逃逸', () => {
  // 这条守的是一个**安全边界**，不是洁癖：`readLocalTranscript` 的路径来自渲染层经 IPC 递进来的
  // 不受信输入。围栏原先两侧都只 `resolve()` —— 那只做字符串规范化、**不解符号链接**，
  // 于是扫描根里一条指向根外的链接就能把导入面板变成任意文件读取器。
  //
  // ⚠️ 用例必须真的建一条符号链接。只比字符串的用例证明不了这件事 ——
  // 旧实现在纯字符串层面本来就是"对"的，它错在没看链接。

  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gugu-fence-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('根内的链接指向根外时必须被拒', async () => {
    // 扫描根是 `<原生配置根>/projects`,不是配置根本身。
    const configDir = join(dir, 'cfg')
    const root = join(configDir, 'projects')
    const outside = join(dir, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })

    const secret = join(outside, 'secret.jsonl')
    await writeFile(secret, JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n')

    const escape = join(root, 'looks-legit.jsonl')
    await symlink(secret, escape)

    // 阳性对照：**同一个根、同一把尺子**下，根内的真文件必须读得到 ——
    // 否则「被拒」可能只是因为围栏把所有东西都拒了，这条用例就成了空话。
    const legit = join(root, 'real.jsonl')
    await writeFile(
      legit,
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        cwd: '/tmp',
        message: { role: 'user', content: 'hello' },
      }) + '\n',
    )

    const options = { nativeHomes: { 'claude-code': [configDir], codex: [] } }
    await expect(readLocalTranscript(legit, 'claude-code', options)).resolves.toBeTruthy()
    await expect(readLocalTranscript(escape, 'claude-code', options)).rejects.toThrow(
      /不在允许的扫描目录内/,
    )
  })
})

describe('claude 的两档标题', () => {
  const claude = TRANSCRIPT_SOURCE_SPECS['claude-code']

  // 归并那一半要走真路径(见下面那条用例的说明),所以这里要一个真的扫描根。
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gugu-title-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // 取自 d15 上真实的 `~/.claude/projects/**.jsonl`（600 份会话实测，两种记录各 4530 / 2351 条）。
  // ❌ 不是我编的形状：编样本验自己写的解析器是自证循环。
  const aiTitleRecord = {
    type: 'ai-title',
    aiTitle: '清理 hcom 配置及 Monitor 功能调研',
    sessionId: '1c61886f-19ea-4d63-a90c-410c31775777',
  }
  const customTitleRecord = {
    type: 'custom-title',
    customTitle: 'ali1 机器新装',
    sessionId: '0d063bf6-2f2d-4fe3-a836-d8738f020a3b',
  }

  it('ai-title 也算显式标题（曾被整类漏读）', () => {
    // 曾经只认 custom-title。d15 上 600 份真实会话实测：287 份带标题记录，其中 **274 份只有
    // ai-title** —— 覆盖率 13/287 = 5%，其余全部静默退回「拿首条用户消息截断当标题」。
    expect(claude.readFrame(aiTitleRecord)?.explicitTitle).toBe(aiTitleRecord.aiTitle)
  })

  it('custom-title 带「用户设的」标记，ai-title 不带', () => {
    // 这个标记是下一条断言的机制。没有它就只能靠出现顺序，而顺序不保证。
    expect(claude.readFrame(customTitleRecord)?.explicitTitleIsUserSet).toBe(true)
    expect(claude.readFrame(aiTitleRecord)?.explicitTitleIsUserSet).toBeFalsy()
  })

  it('用户手写的标题不会被引擎拟的盖掉 —— 两种顺序都不会', async () => {
    // 这是这一修里**唯一会静默出错**的那一半：通用层对 explicitTitle 的规则是「后到者覆盖」，
    // 所以只要 ai-title 在文件里排在 custom-title 之后，用户亲手改的名字就没了。
    // 两个方向都断言，才排除「碰巧顺序对」的假绿。
    //
    // ⚠️ **这条用例必须驱动真的归并逻辑,❌ 不许在测试里自己抄一份。**
    //    第一版就是那样写的（在这里复刻了一遍 `absorbFrame` 的三行取值规则），被 review 打回：
    //    它只驱动了 `readFrame`，归并那一半是测试自己的副本 —— 把 `transcriptInventory.ts` 的
    //    `absorbFrame` 退回成无条件 `digest.title = frame.explicitTitle`（正是本用例注释点名的
    //    那个回归），所有断言**照样全绿**。判据的存在不等于判据能判假。
    //
    //    现在走 `readLocalTranscript`：真文件、真围栏、真 spec、真 `absorbFrame`，
    //    与产品里「导入面板列出一份历史」逐字同一条路径。
    const configDir = join(dir, 'cfg')
    const root = join(configDir, 'projects')
    await mkdir(root, { recursive: true })
    const options = { nativeHomes: { 'claude-code': [configDir], codex: [] } }

    // `readLocalTranscript` 对没有任何对话轮次的文件是**抛错**的(transcriptInventory.ts:263-265),
    // 所以样本里必须有一轮真对话 —— 真实转录本来就有。它顺带把「显式标题压过摘句兜底」
    // 也一并验了:这条摘句若赢了,下面三条断言全部会红。
    const turnRecord = {
      type: 'user',
      sessionId: 's-title',
      cwd: '/tmp',
      message: { role: 'user', content: '这句会被截断当兜底标题' },
    }
    const titleOf = async (name: string, records: readonly Record<string, unknown>[]) => {
      const file = join(root, name)
      await writeFile(
        file,
        [turnRecord, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n',
      )
      const session = await readLocalTranscript(file, 'claude-code', options)
      return session?.title ?? null
    }

    expect(await titleOf('a.jsonl', [customTitleRecord, aiTitleRecord]))
      .toBe(customTitleRecord.customTitle)
    expect(await titleOf('b.jsonl', [aiTitleRecord, customTitleRecord]))
      .toBe(customTitleRecord.customTitle)
    // 只有 ai-title 时它就是答案（274/287 的真实情形）。
    expect(await titleOf('c.jsonl', [aiTitleRecord])).toBe(aiTitleRecord.aiTitle)
  })

  // #6822 咕咕派活的会话首轮就是信封:导入清单的兜底标题与预览要正文,❌ 一串 `<gugu_delivery route=…`。
  it('首轮是投递信封时,兜底标题与轮次都取正文', async () => {
    const configDir = join(dir, 'cfg')
    const root = join(configDir, 'projects')
    await mkdir(root, { recursive: true })
    const file = join(root, 'delivered.jsonl')
    const envelope = '<gugu_delivery route="chat" from="Ada" from_id="user:ada" chat="7" chat_kind="dm" msg="msg:1" at="t">\n'
      + '<![CDATA[把登录页的按钮改大]]>\n  <arrival>Sent to you through 咕咕</arrival>\n</gugu_delivery>'
    await writeFile(file, JSON.stringify({ type: 'user', sessionId: 's-d', cwd: '/tmp', message: { role: 'user', content: envelope } }) + '\n')
    const session = await readLocalTranscript(file, 'claude-code', { nativeHomes: { 'claude-code': [configDir], codex: [] } })
    expect(session.title).toBe('把登录页的按钮改大')
    expect(session.turns.map((turn) => turn.content)).toEqual(['把登录页的按钮改大'])
  })

  it('空标题串不当标题（否则会盖掉摘句兜底，变成没有标题）', () => {
    expect(claude.readFrame({ ...aiTitleRecord, aiTitle: '' })?.explicitTitle).toBeUndefined()
    expect(claude.readFrame({ ...customTitleRecord, customTitle: '   ' })?.explicitTitle).toBeUndefined()
  })
})

describe('delivery envelope is a real user turn', () => {
  it('Codex multi-agent v2 subagent transcript is marked as a sidechain', () => {
    expect(isCodexSubagent({
      id: 'child',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    })).toBe(true)
    expect(codexTranscriptSource.readFrame({
      type: 'session_meta',
      payload: {
        id: 'child',
        cwd: '/tmp',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
      },
    })).toMatchObject({ sidechain: true })
    expect(isCodexSubagent({ id: 'fork', forked_from_id: 'parent' })).toBe(false)
  })

  it('codex keeps a canonical delivery envelope while dropping bootstrap XML', () => {
    const codex = TRANSCRIPT_SOURCE_SPECS.codex
    const delivery = '<gugu_delivery route="chat"><![CDATA[来自聊天页的消息]]></gugu_delivery>'

    expect(
      codex.readFrame({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: delivery }],
        },
      })?.turn?.content,
    ).toBe(delivery)
    expect(
      codex.readFrame({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }],
        },
      })?.turn,
    ).toBeUndefined()
  })

  it('claude keeps a canonical delivery envelope while dropping bootstrap XML', () => {
    const claude = TRANSCRIPT_SOURCE_SPECS['claude-code']
    const delivery = '<gugu_delivery route="chat"><![CDATA[来自聊天页的消息]]></gugu_delivery>'

    expect(
      claude.readFrame({
        type: 'user',
        message: { role: 'user', content: delivery },
      })?.turn?.content,
    ).toBe(delivery)
    expect(
      claude.readFrame({
        type: 'user',
        message: { role: 'user', content: '<environment_context>hidden</environment_context>' },
      })?.turn,
    ).toBeUndefined()
  })

  it('claude 忙时到的输入(queued_command 附件行)是一条用户轮,同一形状里不是输入的挡掉', () => {
    const claude = TRANSCRIPT_SOURCE_SPECS['claude-code']
    const queued = (attachment: Record<string, unknown>) =>
      claude.readFrame({ type: 'attachment', uuid: 'q', attachment: { type: 'queued_command', ...attachment } })?.turn
    const delivery = '<gugu_delivery route="chat"><![CDATA[忙时到的]]></gugu_delivery>'

    expect(queued({ commandMode: 'prompt', prompt: [{ type: 'text', text: delivery }] })).toMatchObject({ role: 'user', content: delivery })
    expect(queued({ commandMode: 'prompt', prompt: '人在忙时打的字' })?.content).toBe('人在忙时打的字')
    expect(queued({ commandMode: 'task-notification', prompt: '<task-notification>done</task-notification>' })).toBeUndefined()
    // isMeta 在 attachment 里:正文不以 `<` 开头也要挡。
    expect(queued({ commandMode: 'prompt', prompt: '子 agent 回话', isMeta: true })).toBeUndefined()
    expect(queued({ prompt: '<agent-message from="a1">子 agent 回话</agent-message>', isMeta: true })).toBeUndefined()
  })

  it('claude 按块判「是不是人说的话」:注入块不带走同一行里人说的话,打断标记不是一轮', () => {
    const claude = TRANSCRIPT_SOURCE_SPECS['claude-code']
    const user = (content: unknown) => claude.readFrame({ type: 'user', message: { role: 'user', content } })?.turn

    expect(user([{ type: 'text', text: '<ide_opened_file>a.ts</ide_opened_file>' }, { type: 'text', text: '看一下这个文件' }])?.content).toBe('看一下这个文件')
    expect(user('\n<command-name>/clear</command-name>')).toBeUndefined()
    expect(user([{ type: 'text', text: '[Request interrupted by user]' }])).toBeUndefined()
  })
})

describe('导入面板的引擎清单跟着 core 走', () => {
  // 渲染层那棵树按结构对接、不跨包 import core（见 local-session-source.ts 的说明），
  // 于是这两张表是**手抄**的 —— 抄漏了 tsc 一个字都不会说。
  it('provider 映射覆盖每一个已接通的来源', () => {
    expect(Object.keys(LOCAL_SESSION_ENGINE_PROVIDER).sort()).toEqual(ids)
  })

  it('面板标签覆盖每一个已接通的来源', () => {
    // ENGINE_OPTIONS 已改为从这张表派生，所以守住这张表就等于守住了筛选栏。
    expect(Object.keys(LOCAL_SESSION_ENGINE_LABEL).sort()).toEqual(ids)
    for (const id of TRANSCRIPT_SOURCE_IDS) {
      expect(LOCAL_SESSION_ENGINE_LABEL[id]?.length, `${id} 缺 label`).toBeGreaterThan(0)
    }
  })
})

describe('插件的 history 声明 vs 咕咕真接通了什么', () => {
  // `coexistence.history` 声明的是**咕咕读不读得回来**，判据只有一个：core 的注册表里有没有
  // 它那一份 spec。厂商侧有没有本地历史是另一个命题（#3889 的官方证据矩阵），❌ 不许互推。
  const providerToSource = new Map<string, string>(
    Object.entries(LOCAL_SESSION_ENGINE_PROVIDER).map(([source, provider]) => [provider, source])
  )
  const knownSources = new Set<string>(TRANSCRIPT_SOURCE_IDS)

  const declared = pluginRegistry
    .getAll()
    .map((plugin) => ({
      provider: plugin.metadata.id,
      history: resolveSessionCoexistence(plugin.capabilities.sessionBundle.coexistence).history,
    }))
    .flatMap(({ provider, history }) =>
      history.kind === 'native' ? [{ provider, channel: history.channel }] : []
    )

  it('声明了 history:native 的家，core 里必须真有一份接通的 spec，且 channel 对得上', () => {
    const unwired = declared.flatMap(({ provider, channel }) => {
      const source = providerToSource.get(provider)
      if (!source || !knownSources.has(source)) {
        return [`${provider}: 声明 history:${channel}，但 core 的注册表里没有它的 spec`]
      }
      const spec = TRANSCRIPT_SOURCE_SPECS[source as TranscriptSource]
      return spec.channel === channel
        ? []
        : [`${provider}: 声明 history:${channel}，core 的 spec 却是 ${spec.channel}`]
    })
    expect(unwired).toEqual([])
  })

  it('反向：core 接通了的家，插件那边必须把 history 声明出来', () => {
    // 少声明不会崩，只会让考卷把一条**已经接通**的能力继续记成欠账 —— 数字骗人比数字难看更糟。
    const declaredProviders = new Set(declared.map((entry) => entry.provider))
    const silent = TRANSCRIPT_SOURCE_IDS.filter(
      (id) => !declaredProviders.has(LOCAL_SESSION_ENGINE_PROVIDER[id])
    )
    expect(silent).toEqual([])
  })
})

describe('扫描根来自插件的 nativeHome（B3）', () => {
  // 从前 codex 的 spec 只扫 `~/.codex/sessions`、不看 `CODEX_HOME`:设了它的机器上导入面板列不出那批会话,
  // 预览也被围栏拒掉,而时间线(locate.ts)却找得到。现在两边读同一份插件声明。
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gugu-native-home-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('CODEX_HOME 下的 rollout 列得出来,默认目录里的旧会话也还在', async () => {
    const home = join(dir, 'home')
    const codexHome = join(dir, 'moved-codex')
    const moved = join(codexHome, 'sessions', '2026', '10', '17', 'rollout-2026-10-17T00-00-00-moved.jsonl')
    const old = join(home, '.codex', 'sessions', '2026', '01', '01', 'rollout-2026-01-01T00-00-00-old.jsonl')
    for (const file of [moved, old]) {
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, '{}\n')
    }
    const options = transcriptScanOptions({ CODEX_HOME: codexHome }, home)
    expect(options.nativeHomes.codex).toEqual([codexHome, join(home, '.codex')])
    const listed = (await listLocalTranscriptFiles(options)).filter((job) => job.source === 'codex').map((job) => job.path)
    expect(listed.sort()).toEqual([moved, old].sort())
    // 阴控:不设 CODEX_HOME 时挪过去的那份不在清单里 —— 证明上面那条读的确实是环境变量。
    const unset = (await listLocalTranscriptFiles(transcriptScanOptions({}, home)))
      .filter((job) => job.source === 'codex').map((job) => job.path)
    expect(unset).toEqual([old])
  })

  it('环境变量指向默认目录时只留一份', () => {
    const home = '/home/u'
    expect(nativeHomeRoots(requireNativeHome('claude'), { CLAUDE_CONFIG_DIR: '/home/u/.claude' }, home))
      .toEqual(['/home/u/.claude'])
    expect(nativeHomeRoots(requireNativeHome('claude'), { CLAUDE_CONFIG_DIR: '  ' }, home)).toEqual(['/home/u/.claude'])
  })
})
