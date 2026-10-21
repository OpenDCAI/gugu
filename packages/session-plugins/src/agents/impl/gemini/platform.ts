import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // Gemini CLI 只说 Gemini 那一面(实测 0.57.0:OpenAI 那组规范名在它的发行包里零命中)。
  // ⚠️ 网关上没有这条路由,所以目录里没有任何模型声明它 —— 这家今天列不出平台模型,是**如实的空**,
  //    不是坏掉。要让它有,得先有一家上游提供原生 generateContent。
  wireProtocol: 'gemini-generate-content',
  dialect: 'gemini-env',
  injection: {
    cui: {
      // `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY` / `GEMINI_MODEL` 三个纯环境变量,没有配置
      // 文件、没有 argv(对 gemini-cli 0.57.0 实测,#4655;三键同进同出 —— 半套会把平台 key
      // 打到 Google 默认端点)。lifetime/复用判据与其余 ACP 家同一套语义(heldRecord,
      // ❌ liveInferenceProcess:ACP 适配器池没有可问的进程探针,那会恒假成每次重签)。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
