import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/** 平台额度怎么送进这一家(契约见 session-core `HarnessPlatform`)。纯数据:渲染层也 import 它。 */
export const harnessPlatform = {
  kind: 'supported',
  // codex 的 provider 声明里的 `wire_api` 由下面的 `CODEX_WIRE_API` 查出(codex 只认 responses)。
  wireProtocol: 'openai-responses',
  dialect: 'codex-config-flags',
  injection: {
    tui: {
      credentialSinks: [
        // 推理在 app-server:中转地址进它的 argv(provider 声明),令牌进它的环境。
        { process: 'detachedInference', carrier: 'providerConfigArgs' },
        { process: 'detachedInference', carrier: 'processEnv' },
        // 可见 TUI 只画界面,但它开机要先过 codex 自己的登录闸门 —— 平台额度用户既没有 auth.json 也没有
        // 默认 provider 的登录态。当前 Codex 只会为**已声明的自定义 provider**跳过登录菜单,所以这里既要
        // 给环境里的 key,也要把同一份无密钥 provider 声明交给可见 client。模型钉定两边都有:
        // 新 thread 由 TUI 建、它发的是自己配置里的模型,所以用户选的模型也钉给 TUI(#6264,见
        // codex-app-server-delivery 的 codexTuiModelSelectionArgs)。
        { process: 'visibleClient', carrier: 'processEnv' },
        { process: 'visibleClient', carrier: 'providerConfigArgs' },
      ],
      tokenLifetime: 'detachedInference',
      tokenReuseProbe: 'liveInferenceProcess',
      modelSlots: ['main'],
      wired: true,
    },
    cui: {
      credentialSinks: [
        { process: 'acpAdapter', carrier: 'spawnEnvConfigDocument' },
        { process: 'acpAdapter', carrier: 'processEnv' },
      ],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform

/** codex 的协议旋钮(`model_providers.<id>.wire_api`)由上面声明的协议查出来:改协议只改 `wireProtocol`,表里没有那一档就编译不过。 */
export const CODEX_WIRE_API = ({ 'openai-responses': 'responses' } as const)[harnessPlatform.wireProtocol];
