import {
  platformRidesAdapterProcessEnv,
  type EngineInjectionContract,
} from './engine-injection-contract'

/**
 * Chat UI 那条腿上,这次平台注入该用**哪一种信封** —— `null` = 三种都认领不了。
 *
 * ## 为什么单独成一个纯函数
 *
 * 这段分派原本内联在 `main.ts` 的注入器里,而完备性判据(`platform-adapter-env.test.ts` 的
 * 「没有一格 wired 的 cui 契约是孤儿」)在旁边**另建了一份**同形的分派:一个 `DIALECT_BRANCHES`
 * 集合 + 直接问 `platformRidesAdapterProcessEnv`。两份各自演化的结果是 2026-08-28 owner 实测
 * 撞到的那个:`adapter-env` 这一支**有类型、有消费方(`trustedPlatformInputPatch`)、有判据认领,
 * 却一个产出方都没有** —— main.ts 走完 claude / codex 两支就直接抛
 * 「平台注入方言无法送达适配器」。判据全绿,因为它问的是「这份契约**能不能**骑适配器进程环境」,
 * 而不是「main.ts **真的产出**了 adapter-env 吗」。判据存在,但判不了假。
 *
 * ⇒ 收成一处:注入器与判据从此问同一个函数。删掉下面任何一支,那条完备性用例当场红。
 *
 * ⚠️ 它住在**宿主树**(`electron/`)而不是会话页树里,是那条边界逼出来的正解:
 *    会话页 bundle 不许 import 宿主模块(两侧各打一份,
 *    模块级状态会分家)。本模块只被宿主的 `main.ts` 消费,放宿主树就一条边都不用翻。
 *    ❌ 别把它挪回 `session/main/core/acp/` 再往冻结清单里加一条 —— 那是给自己开例外。
 *
 * ## 顺序是判据的一部分
 *
 * 先让各家自己的方言分支认领,认领不了才问「能不能整份骑进适配器进程环境」——
 * `platformRidesAdapterProcessEnv` 的抬头明写了这条:它回答「这一格能不能用第三种信封」,
 * 不回答「这一格该用哪种」。反过来问会把 claude/codex 也吸进 adapter-env(它们的凭据 sink
 * 声明不同,第一道闸会拦住,但❌ 别把正确性寄托在另一个函数的实现细节上)。
 */
export type PlatformEnvelopeKind = 'session-meta' | 'adapter-spawn' | 'adapter-env'

export function platformEnvelopeKind(
  contract: EngineInjectionContract,
  launch: {
    spawnEnv: Record<string, string>
    settingsDocumentPath: string | null
    platformProvider: { baseUrl: string; apiKey: string } | null
    /** 协议表原话(见 platformRidesAdapterProcessEnv 同名字段):env 方言的第三闸对它、不对 /v1 的 baseUrl。 */
    platformSettingsEnv?: Readonly<Record<string, string>> | null
  },
): PlatformEnvelopeKind | null {
  // claude 系:凭据按会话寻址,进 `session/new` 的 `_meta`。
  if (contract.dialect === 'provider-env') return 'session-meta'
  // codex:带 provider 声明的载荷,适配器拿它重建 codex 的 config。
  if (contract.dialect === 'codex-config-flags') return 'adapter-spawn'
  // qwen / kimi / copilot 那一族:整份是环境变量,骑能力注入那条腿已有的 `capabilitySpawnEnv`。
  if (platformRidesAdapterProcessEnv(contract, launch)) return 'adapter-env'
  return null
}
