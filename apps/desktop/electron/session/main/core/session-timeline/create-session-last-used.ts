import type {
  SessionpageSessionCreateLastUsed,
} from '@gugu/session-core/session-record/contract';
import type { SessionRow } from '@main/db/schema';
import { sessionViewOfRuntime } from '@shared/core/sessions/sessions';
import { platformOptionId } from '@shared/platform-model-id';
import type { SessionPlatformModel } from '../sessions/platform-model-selection';

/**
 * 一条会话行 → 它被**新建**时用的那一套(behavior mobile-session-view「新建会话沿用上次的选择」)。
 *
 * 不算「新建」的返回 null:没有首轮(分叉 / 导入出来的)、有父会话(agent 起的子会话),或行上缺 provider。
 * `platformModel` 是这条会话在 composer 记下的平台模型选择(`sessionPlatformModel` 的三态):
 * 对象 = 咕咕平台模型,编成与 create 请求同一套的 `platform:<id>`;null / undefined = harness 自家,取 config.model。
 */
export function lastUsedFromSession(
  row: Pick<SessionRow, 'projectId' | 'provider' | 'config' | 'parentSessionId'>,
  platformModel: SessionPlatformModel | undefined,
): SessionpageSessionCreateLastUsed | null {
  const config = row.config;
  if (!row.provider || row.parentSessionId || !config?.firstUtterance) return null;
  return {
    projectId: row.projectId,
    harness: row.provider,
    sessionView: sessionViewOfRuntime(config.type),
    permissionMode: config.permissionMode ?? null,
    model: platformModel ? platformOptionId(platformModel.modelId) : config.model?.trim() || null,
    effort: config.effort?.trim() || null,
  };
}
