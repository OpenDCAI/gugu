import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // opencode —— 旋钮是 provider 的 `npm`。它自己文档的原话:「`@ai-sdk/openai-compatible`
  //   (用于 `/v1/chat/completions`);如果模型走 `/v1/responses`,用 `@ai-sdk/openai`」。
  //   实测 opencode 1.18.28 同一份配置只换这一个字段:
  //     `@ai-sdk/openai-compatible` → POST /v1/chat/completions(owner 撞到的那一格)
  //     `@ai-sdk/openai`            → POST /v1/responses
  //   ⇒ 包名由这里的 wireProtocol 查出(helpers/opencode-family-platform-model.ts 的 `OPENCODE_FAMILY_SDK_PACKAGE`)。
  wireProtocol: 'openai-responses',
  dialect: 'opencode-config-content',
  injection: {
    tui: {
      // 与 codex 同形:推理在咕咕持有的 `opencode serve` 里,配置文档(含中转与令牌)在它 spawn 时进环境;
      // pty 里的 `opencode attach` 只渲染。可见进程重拉时 serve 被复用 ⇒ 令牌必须随 serve 复用,
      // 重签会先撤销 serve 手里那一份,之后每一轮都是 `Not Found`(#6168 A 读数)。
      credentialSinks: [{ process: 'detachedInference', carrier: 'spawnEnvConfigDocument' }],
      tokenLifetime: 'detachedInference',
      tokenReuseProbe: 'liveInferenceProcess',
      modelSlots: ['main'],
      wired: true,
    },
    cui: {
      credentialSinks: [{ process: 'acpAdapter', carrier: 'spawnEnvConfigDocument' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
