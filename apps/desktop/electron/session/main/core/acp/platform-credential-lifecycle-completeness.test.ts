import { describe, expect, it } from 'vitest'
import { resolveUnitDelivery } from '@gugu/session-core/agents/plugins'
import {
  pluginRegistry,
  resolveSessionpageCredentialLifecycle,
  resolveSessionpageNativeSurface,
} from '@gugu/session-plugins/agents'
import { findInjectionContract, platformProtocolForEngine } from '../../../../engine-injection-contract'

type SessionpageSurface = 'acp' | 'tui'

/**
 * 能拿到平台令牌的 (家, 腿),每一格都必须声明凭据生命周期。
 *
 * 恢复闸(`sessionpage-platform-recovery.ts`)对「带平台代际、却查不到声明」的目标一律 `failed`,
 * 聊天页发送与收件都停在那里 —— 这是 spec 要的 fail-loud。缺的是**声明这一侧的完备性**:
 * `credentialLifecycle` 在 descriptor 上是可选的,而原来的判据按家点名(当时只点了 pi),
 * 于是 qwen / copilot / kimi / hermes / gemini / qoder 能签平台令牌、却没有任何判据要求它们声明
 * (#5910 修 pi,#6184 / #6179 撞到 qwen 与 copilot)。
 *
 * 这里按**平台资格**的唯一真值(插件 `platform` 声明了协议的家)枚举,不按名单:下一家接上平台模型,
 * 没写声明这条就红。「这条腿拿不拿得到令牌」只读两份既有声明,不另立名单:
 * - ACP 腿:注入器 `requireInjectionContract(id, 'cui')` 要求 wired 的契约,否则不签;
 * - 两条腿:那条腿的 model 单元要是 native —— model 为 none 的腿不接收平台模型。
 */
function platformLegs(): Array<{ engineId: string; surface: SessionpageSurface }> {
  const legs: Array<{ engineId: string; surface: SessionpageSurface }> = []
  for (const plugin of pluginRegistry.getAll()) {
    const engineId = plugin.metadata.id
    if (!platformProtocolForEngine(engineId)) continue
    const bundle = plugin.capabilities.sessionBundle
    for (const surface of Object.keys(bundle.sessionpage) as SessionpageSurface[]) {
      if (surface === 'acp' && !findInjectionContract(engineId, 'cui')?.wired) continue
      // session-TUI 可以是另一条腿上的可见 adapter(codex 的 app-server);model 单元按真正承载它的那条腿读。
      const nativeSurface = resolveSessionpageNativeSurface(engineId, surface)
      if (!nativeSurface) continue
      if (resolveUnitDelivery(bundle.units.model, nativeSurface).kind !== 'native') continue
      legs.push({ engineId, surface })
    }
  }
  return legs
}

describe('platform credential lifecycle completeness', () => {
  const legs = platformLegs()

  it('enumerates the platform legs from declarations, not a hand-kept list', () => {
    // 阳控:已知必在的几格确实被枚举到;已知不签令牌的格确实被排除。
    const keys = legs.map((leg) => `${leg.engineId}/${leg.surface}`)
    expect(keys).toEqual(expect.arrayContaining([
      'claude/tui', 'codex/tui', 'pi/acp', 'qwen/tui', 'copilot/tui',
    ]))
    expect(keys).not.toContain('qoder/acp')
    expect(keys).not.toContain('hermes/tui')
  })

  it.each(legs.map((leg) => [`${leg.engineId}/${leg.surface}`, leg] as const))(
    '%s declares how its platform credential is delivered and recovered',
    (_name, leg) => {
      expect(resolveSessionpageCredentialLifecycle(leg.engineId, leg.surface)).not.toBeNull()
    },
  )
})
