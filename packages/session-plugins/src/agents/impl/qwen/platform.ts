import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // qwen —— 有环境变量旋钮(`ANTHROPIC_BASE_URL/API_KEY/MODEL` 三件套,实测 0.21.15 即可,
  //   打的是 `POST /v1/messages`),但那条只能到 **messages**、到不了 responses。代价两项:
  //   ① messages 那条路上没有 gpt-5.5 / gpt-5.6 / gpt-6-astra(Codex 中转不提供原生 messages),
  //      qwen 会平白少三个型号;② 咕咕的 anthropic 注入是**故意**把 `ANTHROPIC_API_KEY` 置空、
  //      走 `ANTHROPIC_AUTH_TOKEN` 的(见 modelAccess 那段注释),而 qwen 读的恰恰是前者,
  //      还要再动一处方言。⇒ 收益为负,留在 chat。
  wireProtocol: 'openai-chat-completions',
  dialect: 'qwen-openai-env',
  injection: {
    cui: {
      // `OPENAI_BASE_URL` / `_API_KEY` / `_MODEL` 三个纯环境变量,没有配置文件、没有 argv
      // (对 qwen-code 0.22.0 实测)。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
