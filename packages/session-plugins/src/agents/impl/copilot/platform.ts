import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // copilot —— 旋钮是 `COPILOT_PROVIDER_WIRE_API`(`completions` 默认 / `responses`),出处是
  //   github-copilot-sdk 的 `ProviderConfig.wire_api`。咕咕从前**没设它**,于是落到默认的 completions。
  //   实测 @github/copilot(隔离 HOME + 本地假端点)只加这一个变量:
  //     不设 → POST /v1/chat/completions;`responses` → POST /v1/responses。
  wireProtocol: 'openai-responses',
  dialect: 'copilot-provider-env',
  injection: {
    cui: {
      // 它读自己那套 `COPILOT_PROVIDER_*`,**不认**规范名 `OPENAI_API_KEY`
      // (对 @github/copilot 1.0.80 实测:规范名一点作用都没有)。载体仍是进程环境。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform

/**
 * copilot 的协议旋钮 `COPILOT_PROVIDER_WIRE_API`(github-copilot-sdk `ProviderConfig.wire_api`:「"completions" or "responses".
 * Defaults to "completions"」)由上面声明的协议查出来:改协议只改 `wireProtocol`,表里没有那一档就编译不过。
 */
export const COPILOT_WIRE_API = ({ 'openai-responses': 'responses', 'openai-chat-completions': 'completions' } as const)[
  harnessPlatform.wireProtocol
];
