import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // dsh 的 `llm-deepseek` 路由打 `POST {baseURL}/v1/messages`,key 在 `x-api-key`
  // (`@deepseek-ai/dsh-llm-deepseek-api-key` README「returns the validated API key in `x-api-key`」;
  // 2026-11-05 gpu 假网关实测 0.2.1-rc.5:请求落在 `/v1/messages`,`x-api-key` 是注入的令牌)。
  wireProtocol: 'anthropic-messages',
  dialect: 'dsh-patch-document',
  injection: {
    /**
     * 只有聊天面板一条腿(咕咕只接 dsh 的 ACP)。会话包物化器写一份 0600 的 `--patch` 文档(中转地址、
     * 可切的咕咕模型、令牌读哪个环境变量),路径挂在 argv 上;**令牌**单走进程环境。
     *
     * ⚠️ 为什么非要 `--patch`:那是 dsh 配置的最高一层,压得住用户 `~/.dsh` 里的 profile patch
     *    (实测:用户 patch 把 baseURL 指到别处,请求仍落在 `--patch` 给的地址)。
     * ⚠️ 为什么令牌换一个变量名:dsh 先读自己的凭据库 `$DSH_HOME/.credentials.yaml` 再读进程环境
     *    (README「When the credentials service exists, its precedence applies」)。用户在 dsh 里存过
     *    `DEEPSEEK_API_KEY` 时,平台会话会带着用户自己的 key 打咕咕中转;咕咕自己的变量名它不会有。
     */
    cui: {
      credentialSinks: [
        { process: 'acpAdapter', carrier: 'settingsDocumentFile' },
        { process: 'acpAdapter', carrier: 'processEnv' },
      ],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      // ACP profile 关掉了起标题那一路模型请求(`dsh-acp-app` 的 patch:`session-title-llm` disabled);
      // 压缩也走所选的这一个模型。
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
