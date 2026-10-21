import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // zcode —— 旋钮是咕咕自己写的那份 ZCode provider 表里的 `api.type`(ZCode 认 `anthropic-messages` /
  //   `openai-chat-completions` / `openai-responses` 三档,zai-org/ZCode `packages/provider/src/config/provider-data-schema.ts`),
  //   一个值 ⇒ 拧到 responses。./session-bundle.ts 的 `zcodePlatformEnv` 写表时直接读这里。
  wireProtocol: 'openai-responses',
  dialect: 'zcode-provider-table',
  injection: {
    cui: {
      // 与 copilot 同一条信封(adapter-env):整份 provider 表(含中转与令牌)就在桥进程的一个环境变量里
      // (`ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT` + `ZCODE_PROVIDER`),凭据只骑进程环境;桥启动时把表落成它自己的
      // 0600 临时文件交给 ZCode 后端(ZCode 后端只读文件,桥补丁 0007)。
      credentialSinks: [{ process: 'acpAdapter', carrier: 'processEnv' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      // 主对话用表里选中的那一个。ZCode 会不会自己另点名后台小模型(会话标题等)**未实测**,A/B 里量:
      // 表里只有咕咕给的那几个模型,点名别的会在网关上被拒,读数会是一行裸报错。
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
