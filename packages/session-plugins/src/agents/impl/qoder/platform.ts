import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // qoder —— 它的发行字节(@qoder-ai/qodercli 1.1.56)里 `format` 有三档
  //   `openai`(默认)/ `openai-responses` / `anthropic`,咕咕填的是第一档。旋钮看得见,
  //   但**量不到**:1.1.56 即使配好 BYOK 自定义模型仍被登录闸挡在发请求之前
  //   (`Not logged in · Please run /login`)。❌ 不拿没实测过的值上线 —— 留在 chat,
  //   等哪天能跑通端到端再单独改这一行。
  wireProtocol: 'openai-chat-completions',
  dialect: 'qoder-byok-settings',
  injection: {
    cui: {
      /**
       * ⚠️ 这一格 `wired: false`,是**有意**的,不是忘了接。
       *
       * qoder 的 BYOK 模型文档要经 `--settings <path>` 送达,而会话页 ACP 那条注入信封
       * (`EmdashSessionCapabilityInjection`)**没有 argv 这一格**(见 capability-bundle 里
       * `acpModelHasNoCarrier` 那条降级:「Qoder loads its BYOK model document from `--settings`,
       * and the session-ACP injection envelope carries no argv」)。
       *
       * 声明成 `false` 而不是干脆不写,正是这张表的用途:平台路径撞上它会**响亮失败**并告诉用户
       * 改选该 Agent 自带的模型 —— ❌ 而不是静默跑下去、界面写着咕咕的模型、实际花用户自己的 Key。
       * 要接通,得先给信封加 argv 载体(那是另一刀)。
       */
      credentialSinks: [{ process: 'acpAdapter', carrier: 'settingsDocumentFile' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: false,
    },
  },
} as const satisfies HarnessPlatform
