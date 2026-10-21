import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { openCodeFamilyConfigContent } from '../../helpers/opencode-family-platform-model';
import { MIMOCODE_REASONING_VARIANTS } from './efforts';
import { harnessPlatform } from './platform';

// MiMo-Code 是 sst/opencode 的**品牌化 fork**(主包目录就叫 `packages/opencode`,
// npm 名 @mimo-ai/cli、bin `mimo`),所以配置形状与 opencode 逐字相同,
// 差别只有一个:承载它的环境变量叫 `MIMOCODE_CONFIG_CONTENT`。
// ⇒ 两家**共用同一个构造函数**(`openCodeFamilyConfigContent`),只有 env 键名不同 ——
//   ❌ 别各写一份 JSON:同源的两家一旦配置形状漂移,坏的那家会静默走空配置。
const MIMOCODE_FAMILY_REASONING = {
  displayName: 'MiMo-Code',
  reasoningVariants: MIMOCODE_REASONING_VARIANTS,
} as const;

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_MIMOCODE_MODEL'),
    // 推理档 —— 与 opencode 共用配置文档通道。platformModelForSession 从持久化的
    // conversation config 读取它,因此 ACP 与 pty 不需要各自透传一份起始值。
    reasoningEffort: input.envOverride('GUGU_ACP_MIMOCODE_EFFORT'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  load: (model) =>
    openCodeFamilyConfigContent('MIMOCODE_CONFIG_CONTENT', harnessPlatform.wireProtocol, model, MIMOCODE_FAMILY_REASONING),
};
