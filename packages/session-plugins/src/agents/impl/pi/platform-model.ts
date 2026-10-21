import type { IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

export const platformModel: IPlatformModelBehavior = {
  declare: (input) => {
    // 与 kimi 共用同一个调试开关(搬家前宿主就是这么算的,一字未改)。
    const reasoningEffort = input.requestedEffort || input.envOverride('GUGU_ACP_KIMI_EFFORT');
    return {
      dialect: harnessPlatform.dialect,
      model: input.explicitModel ?? input.envOverride('GUGU_ACP_PI_MODEL'),
      ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
      ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      // 起始思考档 —— 落成 pi 自有配置根 settings.json 的 `defaultThinkingLevel`
      // (见 ./session-bundle 的 `acpSettingsArtifact`;pi `docs/settings.md` 原文
      //  「Startup thinking level … `"off"`,`"minimal"`,`"low"`,`"medium"`,`"high"`,`"xhigh"`」)。
      // ⚠️ 这一格此前**整个漏掉**:composer 选的档走到这里就被丢了,于是 pi 永远只用它自己的默认档,
      //    而界面上明明显示着用户选的那一档 —— 「显示的与真实的对不上」,且不报错。
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  },
  // Pi receives the complete model declaration through its Gugu-owned models.json
  // artifact; the adapter owns the child-env API key and directory pointer.
  load: () => ({}),
};
