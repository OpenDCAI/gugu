import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // CodeBuddy Code 2.169.0:只给 `CODEBUDDY_BASE_URL` + `CODEBUDDY_API_KEY` 时跳过登录闸,
  // 打 `POST {base}/chat/completions`(Bearer),主对话与标题/摘要这些后台请求都用 `CODEBUDDY_MODEL`
  // (2026-10-19 实测 B)。
  wireProtocol: 'openai-chat-completions',
  dialect: 'codebuddy-settings-env',
  injection: {
    /**
     * 两条腿同一套载体:会话包物化器写一份 0600 的 `--settings` 文档(`env` 块里是中转地址与各槽位的
     * 模型),路径挂在 argv 上(ACP 腿经 `capabilityArgs` 进 `codebuddy --acp`);**令牌**单走进程环境 ——
     * CodeBuddy 把加载的 settings 文档整份写进自己的日志,进程环境不写(物化器那一段有实测)。
     *
     * ⚠️ 为什么不只走进程环境:用户 `~/.codebuddy/settings.json` 的 `env` 块压得住进程环境(实测 G:
     *    用户 env 指别处时会话直接失败,界面却写着咕咕的模型),只有 `--settings` 那一层压得住它
     *    (实测 H)。与 qwen 的系统级 settings 副本、pi 的 models.json 同形:模型由这一家自己的物化器
     *    投递(`units.model` = `system-config-overlay`),宿主的平台信封注入器整个跳过。
     */
    cui: {
      credentialSinks: [
        { process: 'acpAdapter', carrier: 'settingsDocumentFile' },
        { process: 'acpAdapter', carrier: 'processEnv' },
      ],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main', 'backgroundUtility'],
      wired: true,
    },
    tui: {
      credentialSinks: [
        { process: 'visibleClient', carrier: 'settingsDocumentFile' },
        { process: 'visibleClient', carrier: 'processEnv' },
      ],
      tokenLifetime: 'visibleClient',
      tokenReuseProbe: 'none',
      modelSlots: ['main', 'backgroundUtility'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
