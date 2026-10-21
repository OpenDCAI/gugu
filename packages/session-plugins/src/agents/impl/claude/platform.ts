import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // Claude Code 打 `ANTHROPIC_BASE_URL` + `/v1/messages`。
  wireProtocol: 'anthropic-messages',
  dialect: 'provider-env',
  injection: {
    tui: {
      credentialSinks: [
        // 模型钉定与中转地址先进进程环境……
        { process: 'visibleClient', carrier: 'processEnv' },
        // ……但用户 settings.json 的 env 块压得住进程环境,所以中转地址与令牌还要再走高一层。
        { process: 'visibleClient', carrier: 'settingsDocumentFile' },
      ],
      tokenLifetime: 'visibleClient',
      tokenReuseProbe: 'none',
      modelSlots: ['main', 'backgroundUtility'],
      wired: true,
    },
    cui: {
      credentialSinks: [
        // 适配器把 `_meta.claudeCode.options` 整包展开进 Agent SDK 的 options:`options.env` 盖过
        // 适配器自己的 process.env,`options.settings` 就是 `--settings` 那一层(传路径,不内联)。
        { process: 'acpAdapter', carrier: 'acpSessionMeta' },
        { process: 'acpAdapter', carrier: 'settingsDocumentFile' },
      ],
      tokenLifetime: 'acpSession',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main', 'backgroundUtility'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
