import { useHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { useAgents } from '@renderer/lib/stores/use-agents';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import { harnessCatalogToOptions } from './harness-model-field';

/**
 * harness 自家的可选模型 —— 问 harness 自己（ACP `session/new` 的
 * `configOptions[category=model]`），❌ 不再读插件里那张静态表。
 *
 * 那张表实测是错的：它钉的 `claude-opus-4-8` 在 claude 2.1.229 里根本不被识别（原样透传、
 * 窗口回落 200K），而 harness 报的 `opus[1m]` 才解析成 `claude-opus-5[1m]`、窗口 1M。
 *
 * 拿不到清单时返回 null = 没有 harness 模型可选（平台模型是另一条来源，照旧并进同一个下拉）。
 *
 * 新建会话页与终端会话顶栏共用这一份:两处都没有一条活的 BYOK 会话可问,唯一看得见
 * 「用户自己凭据下有哪些模型」的就是主进程那趟探针目录(@@@own-model-tier)。
 */
export function useHarnessModelOptions(
  providerId: string | null | undefined,
  /** 替哪条腿读(#6246):两条腿的配置根可能不同,清单也就可能不同。 */
  leg: SessionpageLeg
): Record<string, { name: string }> | null {
  const catalog = useHarnessModelCatalog(providerId, leg);
  const { data: agents } = useAgents();
  const capabilities = providerId
    ? (agents?.find((agent) => agent.id === providerId)?.capabilities ?? null)
    : null;
  // 与 hook 那侧同一口径：只有「不说 ACP」才用插件静态表。
  return harnessCatalogToOptions(
    catalog.state,
    capabilities?.models.kind === 'selectable' ? capabilities.models.modelOptions : undefined
  );
}
