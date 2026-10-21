import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // Pi 的 models.json 由咕咕自己写,provider 与每个模型都标着 `api: 'openai-responses'`
  // (impl/pi/session-bundle.ts 的 modelArtifact)。
  wireProtocol: 'openai-responses',
  dialect: 'pi-models-json',
  injection: {
    tui: {
      credentialSinks: [{ process: 'visibleClient', carrier: 'processEnv' }],
      tokenLifetime: 'visibleClient',
      tokenReuseProbe: 'none',
      modelSlots: ['main'],
      wired: true,
    },
    cui: {
      /**
       * ACP 腿(#5252)。载体与终端腿同源:模型声明落进**咕咕自有配置根**的 `models.json`
       * (由会话包物化器写,`PI_CODING_AGENT_DIR` 指过去),令牌只以 `${GUGU_PI_API_KEY}` 引用出现在
       * 那份文档里、真值仅在适配器进程环境。⇒ sink 记在 `acpAdapter` 上。
       *
       * ⚠️ 这一格的信封**不是** `adapter-env`:`materializeModelCapability('pi-models-json')`
       * 不产出任何 spawnEnv(模型不经环境变量表达),所以 `platformRidesAdapterProcessEnv` 为假。
       * 它由**会话包那条腿**认领 —— main.ts 对 `providerDeliversModelViaConfigFile(id,'acp')`
       * 为真的家先解析平台额度、再让 `platformConfigured` 把平台注入器整个跳过,
       * 与 opencode/mimocode 的 `process-config` 短路是同一个形状的第二个分支。
       */
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform

/** pi `models.json` 里 provider 的 `api`(pi 自己的词表)由上面声明的协议查出来:改协议只改 `wireProtocol`,表里没有那一档就编译不过。 */
export const PI_PROVIDER_API = ({ 'openai-responses': 'openai-responses' } as const)[harnessPlatform.wireProtocol];
