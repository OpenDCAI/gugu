import { describe, expect, it } from 'vitest'
import {
  buildAcpModelCapability,
  materializeModelCapability,
  providerDeliversModelViaConfigFile,
  providerUsesSessionProcessConfig,
} from '../../../../capability-bundle'
import {
  engineInjectionContracts,
  platformRidesAdapterProcessEnv,
  requireInjectionContract,
  shouldReuseHeldPlatformToken,
  type EngineInjectionContract,
} from '../../../../engine-injection-contract'
import { platformEnvelopeKind } from '../../../../platform-envelope'

/**
 * ACP 腿上「平台声明能不能整份骑进适配器进程环境」的判据。
 *
 * ⚠️ 这里的 launch 不是手写 fixture,而是拿**生产的那对函数**(`buildAcpModelCapability` →
 * `materializeModelCapability`,`platformModelForSession` 里逐字同一条)现算出来的。
 * 手写 fixture 只能证明谓词自洽;要证明它对**真实物化结果**判得对,输入就必须来自真实物化。
 */
const RELAY_ROOT = 'https://relay.test.invalid'
const RELAY_BASE_URL = `${RELAY_ROOT}/v1`
const TOKEN = 'platform-session-token-abc123'
const MODEL = 'gugu/glm-5.2'
const CONTEXT_WINDOW = 262_144


interface Launch {
  spawnEnv: Record<string, string>
  settingsDocumentPath: string | null
  platformProvider: { baseUrl: string; apiKey: string }
  platformSettingsEnv: Readonly<Record<string, string>> | null
}

function launchFor(engineId: string): {
  contract: EngineInjectionContract
  launch: Launch
  extraArgs: readonly string[]
} {
  const contract = requireInjectionContract(engineId, 'cui')
  const capability = buildAcpModelCapability({
    dialect: contract.dialect,
    engineId,
    model: MODEL,
    env: {},
    platformAccess: { relayUrl: RELAY_ROOT, token: TOKEN, contextWindow: CONTEXT_WINDOW },
  })
  const materialized = materializeModelCapability(capability)
  const spawnEnv = Object.fromEntries(
    Object.entries(materialized.spawnEnv ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return {
    contract,
    launch: {
      spawnEnv,
      // 生产里这份文档由 `platformModelForSession` 按契约写盘并发布路径;
      // 有 settingsOverride 就等于有文档。
      settingsDocumentPath: materialized.settingsOverride ? '/tmp/gugu-platform-settings.json' : null,
      // 与 main.ts 逐字同源:provider 与协议表原话都从**同一份声明**上取,❌ 不手写 —— 手写的 /v1
      // baseUrl 曾让这张表对 gemini 恒真(它的 env 里是裸根,#4700 B3/B4 就是这么在生产分派上炸的)。
      platformProvider: capability?.platformProvider ?? { baseUrl: RELAY_BASE_URL, apiKey: TOKEN },
      platformSettingsEnv: capability?.platformSettingsEnv ?? null,
    },
    extraArgs: materialized.extraArgs ?? [],
  }
}

describe('platformRidesAdapterProcessEnv', () => {
  it.each(['kimi', 'qwen', 'copilot', 'hermes'] as const)(
    '%s:地址、令牌、模型钉扎全在进程环境里 ⇒ 走 adapter-env 信封',
    (engineId) => {
      const { contract, launch, extraArgs } = launchFor(engineId)

      // 先钉住输入本身,免得下面那个 true 是「因为别的理由」为真的。
      expect(extraArgs).toEqual([])
      expect(launch.settingsDocumentPath).toBeNull()
      expect(Object.values(launch.spawnEnv)).toEqual(expect.arrayContaining([TOKEN, RELAY_BASE_URL]))

      expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(true)
    },
  )

  // #6218 —— copilot 的起始推理档是 argv(`--effort`),随 adapter-env 信封走;带着它,信封判定不变。
  it('copilot:带起始推理档时仍走 adapter-env 信封,argv 只有 --effort <档>', () => {
    const contract = requireInjectionContract('copilot', 'cui')
    const capability = buildAcpModelCapability({
      dialect: contract.dialect,
      engineId: 'copilot',
      model: MODEL,
      env: {},
      platformAccess: { relayUrl: RELAY_ROOT, token: TOKEN, contextWindow: CONTEXT_WINDOW },
      reasoningEffort: 'low',
    })
    const materialized = materializeModelCapability(capability)
    expect(materialized.extraArgs).toEqual(['--effort', 'low'])
    const launch = {
      spawnEnv: materialized.spawnEnv as Record<string, string>,
      settingsDocumentPath: null,
      platformProvider: capability!.platformProvider!,
      platformSettingsEnv: capability?.platformSettingsEnv ?? null,
    }
    expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(true)
    expect(platformEnvelopeKind(contract, launch)).toBe('adapter-env')
  })

  // #6218 —— opencode 的起始档写成 AI SDK option `reasoningEffort`;请求体字段名 `reasoning_effort`
  // 会被 @ai-sdk/openai 静默丢掉(实测:请求体一个推理字段都没有)。
  it('opencode:起始推理档是 provider 包认的 option,不是请求体字段名', () => {
    const capability = buildAcpModelCapability({
      dialect: requireInjectionContract('opencode', 'cui').dialect,
      engineId: 'opencode',
      model: MODEL,
      env: {},
      platformAccess: { relayUrl: RELAY_ROOT, token: TOKEN, contextWindow: CONTEXT_WINDOW },
      reasoningEffort: 'low',
    })
    const doc = JSON.parse(materializeModelCapability(capability).spawnEnv?.OPENCODE_CONFIG_CONTENT ?? '')
    const entry = doc.provider['gugu-platform'].models[MODEL]
    expect(entry.options).toEqual({ reasoningEffort: 'low' })
    expect(entry.variants.high).toEqual({ reasoningEffort: 'high' })
  })

  // ── 反例:codex ────────────────────────────────────────────────────────────
  // 本仓最常用的一家。它的凭据同样进适配器进程,但**模型钉扎走 app-server 的 argv**,
  // env 里一个字节都没有 —— 被这条口径卷进来 = 打死 codex。

  it('codex:模型钉扎是 argv,不是 env ⇒ 判 false', () => {
    const { contract, launch, extraArgs } = launchFor('codex')

    // 这才是 codex 的真载体 —— 先证明它确实在 argv 上,再看谓词怎么判。
    expect(extraArgs).toEqual(expect.arrayContaining(['-c', `model=${MODEL}`]))
    expect(launch.spawnEnv).toEqual({})

    expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(false)
  })

  it('codex:就算有人把它的 sink 声明改宽成纯 processEnv,行为判据照样拦住它', () => {
    const { contract, launch } = launchFor('codex')
    // 闸 1(表上的声明)被人为拆掉 —— 闸 3(env 里到底有没有凭据)必须独立成立。
    const widened: EngineInjectionContract = {
      ...contract,
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
    }

    expect(platformRidesAdapterProcessEnv(widened, launch)).toBe(false)
  })

  /**
   * 闸 1 单独的判据 —— opencode 把整份配置文档(**令牌就在里面**)塞进一个环境变量,
   * 所以闸 2、闸 3 对它都成立;拦住它的只有表上那句「我的载体是 spawnEnvConfigDocument」。
   * 少了闸 1,这条会绿 —— 而表就不再说了算,方言分支的归属会悄悄变成「谁的凭据碰巧在 env 里」。
   */
  it('opencode:令牌确实在 env 里,但表说它的载体是配置文档 ⇒ 仍判 false', () => {
    const { contract, launch } = launchFor('opencode')

    expect(launch.settingsDocumentPath).toBeNull()
    expect(Object.values(launch.spawnEnv).some((value) => value.includes(TOKEN))).toBe(true)

    expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(false)
  })

  it('claude:凭据按会话经 _meta 送达,不在进程环境 ⇒ 判 false', () => {
    const { contract, launch } = launchFor('claude')

    expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(false)
  })

  it('claude:平台目录与 custom alias 一起进入会话 settings,且不依赖用户配置根', () => {
    const capability = buildAcpModelCapability({
      dialect: 'provider-env',
      engineId: 'claude',
      model: 'gpt-5.6-sol',
      env: {},
      platformAccess: { relayUrl: RELAY_ROOT, token: TOKEN, contextWindow: CONTEXT_WINDOW },
      platformModels: [
        { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
        { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
      ],
    })
    const materialized = materializeModelCapability(capability)
    const settings = materialized.settingsOverride as {
      availableModels?: string[]
      modelPicker?: { options?: Array<{ model?: string; label?: string }> }
      env?: Record<string, string>
    }

    expect(settings.availableModels).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
    expect(settings.modelPicker?.options).toEqual([
      { model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ])
    expect(settings.env).toEqual(expect.objectContaining({
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'gpt-5.6-sol',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    }))
  })

  it('claude:1M 的 claude-* 平台模型按 Claude Code 认窗口的写法 `[1m]` 交过去 —— 选单、白名单、后台档同一写法', () => {
    const capability = buildAcpModelCapability({
      dialect: 'provider-env',
      engineId: 'claude',
      model: 'claude-opus-5',
      env: {},
      platformAccess: { relayUrl: RELAY_ROOT, token: TOKEN, contextWindow: 1_000_000 },
      platformModels: [
        { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000 },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', contextWindow: 1_000_000 },
        { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000 },
        { id: 'claude-sonnet-x', displayName: 'Sonnet X', contextWindow: 500_000 },
      ],
    })
    const materialized = materializeModelCapability(capability)
    const settings = materialized.settingsOverride as {
      availableModels?: string[]
      modelPicker?: { options?: Array<{ model?: string; label?: string }> }
      env?: Record<string, string>
    }

    expect(settings.availableModels).toEqual(['claude-opus-5[1m]', 'claude-opus-5-5[1m]', 'glm-5.3', 'claude-sonnet-x'])
    expect(settings.modelPicker?.options).toEqual([
      { model: 'claude-opus-5[1m]', label: 'Claude Opus 5' },
      { model: 'claude-opus-5-5[1m]', label: 'Claude Opus 5.5' },
      { model: 'glm-5.3', label: 'GLM-5.3' },
      { model: 'claude-sonnet-x', label: 'Sonnet X' },
    ])
    expect(settings.env).toEqual(expect.objectContaining({
      ANTHROPIC_MODEL: 'claude-opus-5[1m]',
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-opus-5[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5[1m]',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-opus-5[1m]',
    }))
    expect(materialized.spawnEnv?.ANTHROPIC_MODEL).toBe('claude-opus-5[1m]')
  })

  // ── 反例:半份注入 ─────────────────────────────────────────────────────────
  // 「模型钉成一个网关认得、凭据却没到」的会话比不注入更糟:每一轮都被网关拒,
  // 而用户看到的只是会话起不来。

  it('只钉了模型、凭据没进 env ⇒ 判 false', () => {
    const { contract } = launchFor('kimi')

    expect(platformRidesAdapterProcessEnv(contract, {
      spawnEnv: { KIMI_MODEL_NAME: MODEL },
      settingsDocumentPath: null,
      platformProvider: { baseUrl: RELAY_BASE_URL, apiKey: TOKEN },
    })).toBe(false)
  })

  it('比的是**这一次**会话的令牌,不是「env 非空」', () => {
    const { contract, launch } = launchFor('kimi')

    expect(platformRidesAdapterProcessEnv(contract, {
      ...launch,
      platformProvider: { ...launch.platformProvider, apiKey: 'some-other-sessions-token' },
    })).toBe(false)
  })

  it('这一格还要一份落盘的 settings 文档 ⇒ 判 false(信封带不走路径)', () => {
    const { contract, launch } = launchFor('kimi')

    expect(platformRidesAdapterProcessEnv(contract, {
      ...launch,
      settingsDocumentPath: '/tmp/gugu-platform-settings.json',
    })).toBe(false)
  })

  it('不上平台额度(没有中转声明)⇒ 判 false', () => {
    const { contract, launch } = launchFor('kimi')

    expect(platformRidesAdapterProcessEnv(contract, {
      ...launch,
      platformProvider: null,
    })).toBe(false)
  })
})

describe('platformRidesAdapterProcessEnv · gemini(裸根方言,#4700)', () => {
  const { contract, launch } = launchFor('gemini')

  it('env 里是协议表原话(裸根 + 令牌)⇒ 判 true;platformProvider.baseUrl 的 /v1 不是它的地址', () => {
    expect(launch.spawnEnv.GOOGLE_GEMINI_BASE_URL).toBe(RELAY_ROOT)
    expect(launch.platformProvider.baseUrl).toBe(RELAY_BASE_URL)
    expect(platformRidesAdapterProcessEnv(contract, launch)).toBe(true)
  })

  it('反例:不带协议表原话去问(拿 /v1 的 baseUrl 对裸根)⇒ 判 false —— 这正是 B3/B4 的红', () => {
    expect(platformRidesAdapterProcessEnv(contract, { ...launch, platformSettingsEnv: null })).toBe(false)
  })

  it('比的仍是这一次会话的令牌:原话里的令牌换成别的 ⇒ 判 false', () => {
    expect(platformRidesAdapterProcessEnv(contract, {
      ...launch,
      platformSettingsEnv: { ...launch.platformSettingsEnv, GEMINI_API_KEY: 'some-other-sessions-token' },
    })).toBe(false)
  })
})

describe('Chat UI 平台注入的完备性', () => {
  /**
   * 每一格 `wired` 的 cui 契约都必须有**认领人**,否则它就是下一个 kimi:
   * composer 里列得出咕咕的模型,真起会话时落到 `dialectUnsupported` 那一行。
   *
   * ⚠️ **这条判据 2026-08-28 之前判不了假**,而它守的那件事当时正在真实地坏着。
   * 旧版在这里**另建了一份**与 main.ts 同形的分派(一个 `DIALECT_BRANCHES` 集合 + 直接问
   * `platformRidesAdapterProcessEnv`),于是它问的是「这份契约**能不能**骑适配器进程环境」,
   * 而 main.ts 问的是「我这里有没有写一支产出它的分支」。两个问题的答案在 `adapter-env`
   * 那一支上分道扬镳:类型有、消费方(`trustedPlatformInputPatch`)有、判据也认领了,
   * **产出方一个都没有** —— main.ts 走完 claude / codex 两支就抛。owner 2026-08-28 在
   * kimi 上实测撞到,而这条用例全程是绿的。
   *
   * ⇒ 现在两边问同一个 `platformEnvelopeKind`。删掉它任何一支,这里当场红(已做变异验证)。
   *
   * 认领人仍是三个,只是前两个收进了那个函数:方言分支(claude / codex)、adapter-env,
   * 以及会话包的 process-config 那条腿(opencode / mimocode 由 MCP 注入器直接短路,
   * 平台注入器那一格根本不参与,所以在函数之外单独排除)。
   */
  it('没有一格 wired 的 cui 契约是孤儿 —— 问的是 main.ts 真正用的那份分派', () => {
    const orphans = engineInjectionContracts()
      .filter((contract) => contract.surface === 'cui' && contract.wired)
      .filter((contract) => !providerUsesSessionProcessConfig(contract.engineId))
      // 第二个「会话包自己认领」的分支 —— main.ts 的条件是
      // `ownsProcessConfig || modelViaConfigFile`,这张判据此前只建模了前一个析取项。
      // 模型经**咕咕自己写的一份配置文件**送达的家(pi 的 `PI_CODING_AGENT_DIR/models.json`),
      // 同样由会话包在 spawn 那一刻兑现,并靠 `platformConfigured` 让平台注入器整个不参与
      // ⇒ 它不是孤儿。❌ 别写成按 engineId 的白名单:那就成了一次性例外,
      //    而这里要问的是「这一格有没有产出方」,答案由声明推导。
      .filter((contract) => !providerDeliversModelViaConfigFile(contract.engineId, 'acp'))
      .filter((contract) => platformEnvelopeKind(contract, launchFor(contract.engineId).launch) === null)
      .map((contract) => contract.engineId)

    expect(orphans).toEqual([])
  })

  /**
   * 上一条的**反空洞对照**:它只说「没有 null」,而全都判成同一种信封也满足那句话。
   * 这里逐家钉住**具体哪一种** —— 三支各有真实的代表,少一支就说明那支被谁吸走了。
   */
  it('三种信封各自认领的是哪几家', () => {
    const kindOf = (engineId: string) =>
      platformEnvelopeKind(requireInjectionContract(engineId, 'cui'), launchFor(engineId).launch)

    expect(kindOf('claude')).toBe('session-meta')
    expect(kindOf('codex')).toBe('adapter-spawn')
    for (const engineId of ['kimi', 'qwen', 'copilot', 'zcode'] as const) {
      expect(kindOf(engineId)).toBe('adapter-env')
    }
  })

  /**
   * 重开一条**还活着**的 Chat UI 会话时,令牌必须复用而不是重签。
   *
   * `SessionManager.start` 对已经存在的会话直接返回,而平台注入器在它之前就跑完了 —— 重签会先撤销
   * 活适配器手里那张票,此后每一轮 401(台账 3 号)。注入器那条腿上 `inferenceProcessLive` 是写死的
   * `false`(ACP 适配器池没有可问的进程探针),所以 `liveInferenceProcess` 档在这里**等价于 `none`**,
   * 正是契约表自己写着「❌ 不用 `none`」的那个行为。声明与接线各说各的,而两边都不会响。
   */
  it('cui 上每一格 wired 的契约都会复用已签发的令牌,而不是重签', () => {
    const reSignsUnderLiveSession = engineInjectionContracts()
      .filter((contract) => contract.surface === 'cui' && contract.wired)
      .filter((contract) => !shouldReuseHeldPlatformToken(contract, {
        // 与 main.ts 注入器那一格逐字一致 —— ❌ 别在这里假设一个它给不出的 true。
        inferenceProcessLive: false,
        heldRecordExists: true,
      }))
      .map((contract) => contract.engineId)

    expect(reSignsUnderLiveSession).toEqual([])
  })

  /**
   * 上一条的**阳性对照**:三个认领人里的中间那个必须真的在认人。它若整体失效
   * (registry 没装起来之类),上面那条会因为「谁都认领不了」而红 —— 但也可能因为
   * 别的巧合而绿,所以这里单独钉一次读数。
   */
  it('process-config 那条腿确实认领了 opencode 系,且没有顺手认领 kimi', () => {
    expect(providerUsesSessionProcessConfig('opencode')).toBe(true)
    expect(providerUsesSessionProcessConfig('mimocode')).toBe(true)
    expect(providerUsesSessionProcessConfig('kimi')).toBe(false)
    expect(providerUsesSessionProcessConfig('codex')).toBe(false)
  })
})
