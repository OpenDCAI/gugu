import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 资源库 →「智能体」与 composer 必须看到**同一集合** —— #6099（owner 2026-09-21
 * 「29 家不上架的插件保留代码、先不上架」）。真机症状：mac1 上资源库 21 行全 Installed、
 * composer 只有 7 家，搜 gemini 零结果 —— 同一台机器两个答案。
 *
 * #4833 记下的洞正是「不暴露」是**涌现属性**：没有任何判据钉住暴露集合，于是它可以被某一条
 * 用户面自己的补偿逻辑悄悄放宽。这个文件就是那根钉子，钉的是**两条面各自的入口函数**
 * （`buildAgentPayloads` / `buildManagementAgentPayloads`）——❌ 不是名单函数：上次漂移发生在
 * 投影这一层（名单是对的，投影自己把 withheld 家补回来了），只钉名单照不出它。
 */
vi.mock(
  '../../../../apps/desktop/electron/session/main/core/settings/provider-settings-service',
  () => ({
    providerOverrideSettings: {
      getItemWithMeta: async () => ({ value: {}, defaults: {}, overrides: {} }),
    },
  }),
)

const { buildAgentPayloads, buildManagementAgentPayloads } = await import(
  '../../../../apps/desktop/electron/session/main/core/agents/agent-payload-builder'
)
const { pluginRegistry, WITHHELD_FAMILIES } = await import('@gugu/session-plugins/agents')

/**
 * 「每一家都已装好」的替身 —— 这就是上次那份补偿逻辑的**触发条件**：它按
 * `get(id).status === 'available'` 把 withheld 家补回资源库。⇒ 这是阳控，不是布景：
 * 旧实现在这个输入下必然把 21 家 withheld 全列出来，判据当场红。
 */
const allInstalled = {
  platform: 'darwin' as const,
  get: () => ({ status: 'available' as const }),
  getHostDependency: () => undefined,
} as unknown as Parameters<typeof buildAgentPayloads>[1]

const idsOf = async (
  build: typeof buildAgentPayloads,
  manager?: Parameters<typeof buildAgentPayloads>[1],
) => (await build(undefined, manager)).map((payload) => payload.id).sort()

describe('资源库 →「智能体」与 composer 共用一份上架名单 (#6099)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('两条面看到同一集合 —— 连「每一家都已装好」时也是（旧实现在这里补回 withheld 家）', async () => {
    const composer = await idsOf(buildAgentPayloads, allInstalled)
    const library = await idsOf(buildManagementAgentPayloads, allInstalled)

    // 阴控：集合不能是空的 —— 空集合也能让上面那句「相等」成立。
    expect(composer.length).toBeGreaterThan(0)
    expect(library).toEqual(composer)

    // 阳控的对象必须真的存在：替身声称「装好了」的那些 withheld 家得确有注册面，
    // 否则这条用例只是在一个空集合上宣布胜利。
    const registeredWithheld = WITHHELD_FAMILIES.filter((id) => pluginRegistry.get(id))
    expect(registeredWithheld.length).toBeGreaterThan(0)
    expect(library.filter((id) => registeredWithheld.includes(id as never))).toEqual([])
  })

  it('没有兜底开关时，注册过但没上架的家两条面都看不见（gemini = 真机那格）', async () => {
    // 先证明它确实注册着 —— 「看不见」得是被闸挡的，不是压根没这一家。
    expect(pluginRegistry.get('gemini')).toBeTruthy()

    const composer = await idsOf(buildAgentPayloads, allInstalled)
    const library = await idsOf(buildManagementAgentPayloads, allInstalled)
    expect(composer).not.toContain('gemini')
    expect(library).not.toContain('gemini')

    // 上架的家仍在两条面上 —— 否则「不含 gemini」也可能只是因为列表整个塌了。
    expect(composer).toContain('claude')
    expect(library).toContain('claude')
  })

  it('兜底开关对两条面一视同仁：开了之后两边一起变成全量注册面', async () => {
    const before = await idsOf(buildManagementAgentPayloads, allInstalled)

    vi.stubEnv('GUGU_SHOW_UNSUPPORTED_AGENTS', '1')
    const composer = await idsOf(buildAgentPayloads, allInstalled)
    const library = await idsOf(buildManagementAgentPayloads, allInstalled)
    const registered = pluginRegistry
      .getAll()
      .map((provider) => provider.metadata.id)
      .sort()

    expect(library).toEqual(composer)
    expect(library).toEqual(registered)
    // 开关真的起了作用（否则上面三句在「开关根本没被读」时也全部成立）。
    expect(library.length).toBeGreaterThan(before.length)
  })
})
