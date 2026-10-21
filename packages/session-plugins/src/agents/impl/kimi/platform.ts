import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // kimi —— 同一个形状。`KIMI_MODEL_PROVIDER_TYPE` 的取值域是它发行字节里的
  //   `ALLOWED_TYPES = ["kimi", "anthropic", "openai"]` —— **没有 responses 这一档**,
  //   拧过去只能到 messages,同样丢掉 GPT 那三个。(实测 kimi 0.41.0:`anthropic` → `POST
  //   /v1/messages?beta=true`,且 base 带不带 `/v1` 它都归一化,所以地址不用改。)
  wireProtocol: 'openai-chat-completions',
  dialect: 'kimi-model-env',
  injection: {
    cui: {
      // `KIMI_MODEL_NAME` 是触发变量,`_API_KEY` / `_BASE_URL` / `_PROVIDER_TYPE` 随行;纯环境变量。
      // 上游真源码:`packages/agent-core/src/config/env-model.ts` 逐字读这几个键,在**内存里**合成
      // 一个临时 provider + 模型别名,不写回 `config.toml`(所以与 `$KIMI_CODE_HOME` 那条路无关)。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
