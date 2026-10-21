import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { forgetSessionPlatformModel, recordSessionPlatformModel } from './platform-model-selection';

/**
 * 一条**从没起来过**的会话(没有 provider 会话可续)换模型 / 档位:只把选择落进会话记录。
 *
 * 没有进程要停、也没有历史要续 —— 它下一次起就是首启,spawn 按记录重算整份注入。所以这里 ❌ 不停不起,
 * 起它的是调用方那条正常的启动路(终端:hydrate 重试;通用模式:`store.retry()`)。
 * 典型场景(#7092):免费号建了一条用会员模型的任务,签票被拒、首启失败;用户换一个能用的模型,再起。
 *
 * 落记录的规则与重开那条路(`reloadEmdashSession`)相同 —— 同一个决定,只是这次没有进程可重开:
 * 平台模型只进平台记录、`config.model` 删键;自己的模型进 `config.model`、平台记录记 `null`;
 * 清模型两半一起清。平台记录没写上就把 config 退回原样,❌ 不留「config 说一条路、平台记录说另一条」。
 */
export async function recordUnstartedSessionChoice(input: {
  sessionId: string;
  runtime: 'acp' | 'pty';
  reason: string;
  model?: string | null;
  modelSource?: 'platform' | 'own';
  resetModel?: boolean;
  /** 三态:字符串 = 换成这一档;`null` = 删键、回 harness 默认;缺席 = 不碰。只收终端会话。 */
  effort?: string | null;
}): Promise<void> {
  const { sessionId, reason } = input;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null;
  if (model && input.resetModel) {
    throw new Error(`session ${sessionId} asked to both reset and set a model (${reason})`);
  }
  if (model && input.modelSource !== 'platform' && input.modelSource !== 'own') {
    throw new Error(
      `session ${sessionId} asked to switch to ${model} without saying which billing path it is on (modelSource)`
    );
  }
  if (input.runtime === 'acp' && input.effort !== undefined) {
    throw new Error(`session ${sessionId} ACP session takes effort on the live session, not on the record`);
  }
  if (!model && !input.resetModel && input.effort === undefined) {
    throw new Error(`session ${sessionId} has nothing to record (${reason}); start it normally instead`);
  }

  const rows = await db
    .select({ projectId: sessions.projectId, config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const row = rows[0];
  const current = row?.config;
  if (!row || !current || typeof current !== 'object') {
    throw new Error(`session ${sessionId} has no config to update (${reason})`);
  }
  const next: Record<string, unknown> = { ...current };
  if (model) {
    if (input.modelSource === 'platform') delete next.model;
    else next.model = model;
  } else if (input.resetModel) {
    delete next.model;
  }
  const effort = typeof input.effort === 'string' && input.effort.trim() ? input.effort.trim() : null;
  if (input.effort !== undefined) {
    if (effort) next.effort = effort;
    else delete next.effort;
  }
  await db.update(sessions).set({ config: next as typeof current }).where(eq(sessions.id, sessionId));
  try {
    if (model) {
      await recordSessionPlatformModel(sessionId, input.modelSource === 'platform' ? { modelId: model } : null);
    } else if (input.resetModel) {
      await forgetSessionPlatformModel(sessionId);
    }
  } catch (error) {
    await db.update(sessions).set({ config: current }).where(eq(sessions.id, sessionId));
    throw error;
  }

  // 渲染层通用模式的启动路读的是它手里那份会话(`_startInput` 的 model / effort),不跟上就按旧值起。
  const changes: { model?: string | null; effort?: string | null } = {};
  if (model || input.resetModel) changes.model = model && input.modelSource === 'own' ? model : null;
  if (input.effort !== undefined) changes.effort = effort;
  if (Object.keys(changes).length > 0) {
    events.emit(sessionChangedChannel, { sessionId, projectId: row.projectId, changes });
  }
}
