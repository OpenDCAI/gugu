/**
 * 平台会话交给 codex app-server 启动方的模型事实 —— 全部取自网关模型目录,随令牌一起签发。
 *
 * 启动方(ACP 桥 `runtime/codex-app-server-acp.mjs`、编程面 `CodexAppServerSession`)用
 * `runtime/codex-model-catalog.mjs` 把它渲染成 codex 的 `model_catalog_json`:codex 对网关别名
 * 不再用 fallback metadata(272k 窗口上限、无推理档、每轮一句警告)。
 * 目录新上架一个模型,它就随可切集合进来 —— ❌ 不在这里按模型名写任何一条。
 *
 * 推理档也是**逐模型**的目录事实(`billing.platform_models.reasoning_efforts`,#6447):glm-5.3 只认
 * low/high/max,claude-opus-5 到 max。交给 codex 之前收窄到 codex 自己的词表(`CODEX_EFFORT_OPTIONS`):
 * 目录的取值来自 models.dev,一个 codex 不认识的档名会让它拒掉整份 catalog。
 * 目录没有这条事实(null)与目录说没有这根轴(`[]`)对 codex 是同一件事 —— 这个模型不给档位;
 * ❌ 不拿一张全局表替它编(那正是 #6447 修掉的东西)。
 */
import { CODEX_EFFORT_OPTIONS } from './efforts';

export const GUGU_PLATFORM_MODELS_ENV = 'GUGU_PLATFORM_MODELS';

type PlatformModelFact = {
  id: string;
  displayName: string;
  contextWindow?: number | null;
  reasoningEfforts?: readonly string[] | null;
};

export function codexPlatformModelFacts(input: {
  model: string;
  contextWindow?: number | null;
  /** 选中模型的推理档;可切集合里有它时以那一条为准。 */
  reasoningEfforts?: readonly string[] | null;
  /** 这条会话可热切到的整组平台模型(令牌的白名单);服务端没报就只有 `model` 自己。 */
  models?: readonly PlatformModelFact[];
}): string {
  const selected = input.model.trim();
  const entries = (input.models ?? []).map((entry) => ({
    id: entry.id.trim(),
    displayName: entry.displayName,
    contextWindow: entry.contextWindow ?? null,
    reasoningEfforts: entry.reasoningEfforts ?? null,
  }));
  const own = entries.find((entry) => entry.id === selected);
  if (!own) {
    entries.unshift({
      id: selected,
      displayName: selected,
      contextWindow: input.contextWindow ?? null,
      reasoningEfforts: input.reasoningEfforts ?? null,
    });
  } else {
    if (own.contextWindow === null) own.contextWindow = input.contextWindow ?? null;
    if (own.reasoningEfforts === null) own.reasoningEfforts = input.reasoningEfforts ?? null;
  }
  return JSON.stringify(entries.map(({ reasoningEfforts, ...entry }) => ({
    ...entry,
    efforts: (reasoningEfforts ?? []).filter((effort) => Object.hasOwn(CODEX_EFFORT_OPTIONS, effort)),
  })));
}
