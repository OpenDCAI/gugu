import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // 咕咕在 hermes serve 的托管配置里写一个具名 provider,它的 `transport` 由下面的 `HERMES_TRANSPORT` 查出
  // (具名 provider 默认 chat_completions;上游开发者文档:「Most providers use chat_completions. Codex uses codex_responses.」)。
  wireProtocol: 'openai-responses',
  dialect: 'hermes-serve-env',
  injection: {
    cui: {
      // The relay endpoint and key enter the ACP bridge's process environment; the bridge passes the key on to
      // `hermes serve`'s environment and names it as `${…}` in serve's Gugu-owned managed config, with the model.
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform

/** hermes 托管配置里平台 provider 的 `transport`(runtime/hermes-serve/serve.ts 读)由上面声明的协议查出:改协议只改 `wireProtocol`。 */
export const HERMES_TRANSPORT = ({ 'openai-responses': 'codex_responses', 'openai-chat-completions': 'chat_completions' } as const)[
  harnessPlatform.wireProtocol
];
