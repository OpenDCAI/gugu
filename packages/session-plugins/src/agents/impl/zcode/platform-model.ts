import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';
import { zcodePlatformEnv } from './session-bundle';

// ZCode:咕咕把整份 provider 表(平台中转、令牌、选中的模型与整组可切模型)作为**一个环境变量**交给桥
// (`ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT`,桥补丁 0007 把它落成自己的 0600 临时文件、指给后端 —— ZCode 的
// 后端只读文件)。表的形状与生成函数在 ./session-bundle.ts 的 `zcodePlatformEnv`,物化器与下面的 `load` 读同一个函数。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_ZCODE_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // 非平台会话一个键都不发(zcodePlatformEnv 自己判)。
  load: (model) => ({ spawnEnv: zcodePlatformEnv(model) }),
};
