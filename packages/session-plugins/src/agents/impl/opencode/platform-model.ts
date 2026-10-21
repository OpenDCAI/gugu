import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { OPENCODE_REASONING_VARIANTS } from '../../helpers/opencode-family-model-config';
import { openCodeFamilyConfigContent } from '../../helpers/opencode-family-platform-model';
import { harnessPlatform } from './platform';

/**
 * 推理档在 opencode 系模型条目里的形状 —— 与插件物化那条路共用
 * `OpenCodeFamilyModelSpec` 的同名字段(`../../helpers/opencode-family-model-config.ts`)。
 *
 * OpenCode 与 MiMo-Code 都经同一份 process-config 入口声明三档,payload 都是 AI SDK 的 provider
 * option `reasoningEffort`,由 provider 包翻成线上字段(`OPENCODE_REASONING_VARIANTS` 抬头有实测)。
 * 预发探针证明不推理模型携带推理档也返回 200，因此 OpenCode 不按模型另分支。逐条出处见
 * `impl/mimocode/efforts.ts` 抬头与 #5317 预发探针记录。
 */
const OPENCODE_FAMILY_REASONING = {
  displayName: 'OpenCode',
  reasoningVariants: OPENCODE_REASONING_VARIANTS,
} as const;

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_OPENCODE_MODEL'),
    ...(input.requestedEffort ? { reasoningEffort: input.requestedEffort } : {}),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // 预发探针证明网关对不推理模型也接受推理档,所以所有网关模型统一声明三档。
  load: (model) =>
    openCodeFamilyConfigContent('OPENCODE_CONFIG_CONTENT', harnessPlatform.wireProtocol, model, OPENCODE_FAMILY_REASONING),
};
