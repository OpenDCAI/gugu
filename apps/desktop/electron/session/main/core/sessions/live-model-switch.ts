import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { recordSessionPlatformModel } from './platform-model-selection';

/**
 * 会话中途**当场**换成了一个模型(活会话已确认 `applied`)之后,会话记录跟上。
 *
 * 记录是「这条会话跑哪个模型」在咕咕这一侧的唯一事实:下一次 spawn 按它重算注入,
 * 不报当前模型的 harness(copilot 走自定义 provider 时 `configOptions` 里没有 `model`)的触发器也只能读它。
 * 不跟上的两种症状(#6182):copilot 热切成功、账本已是新模型,触发器仍显示旧模型;
 * 任何一家热切之后冷启动,按旧记录 spawn,悄悄回到旧模型。
 *
 * 写法与重开那条路(`reloadEmdashSession`)落记录的规则相同 —— 它们是同一个决定,只是生效方式不同:
 * 平台模型只进平台记录、`config.model` 删键(`config.model` 是 harness 自家 id 那一半,留着平台 id
 * 会让启动时把它当自家 id 原样 `set_config_option`,opencode 当未知模型拒);自己的模型进 `config.model`,
 * 平台记录记 `null`。下一次启动由 runtime 按这两半把模型断言一次(#6196)。
 *
 * ⚠️ 只在活会话**确认之后**调用 —— 记录先于确认写下,就是「界面/下次启动说换了、实际没换」。
 */
export async function recordLiveModelSwitch(input: {
  sessionId: string;
  modelId: string;
  source: 'platform' | 'own';
}): Promise<void> {
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error(`live model switch for ${input.sessionId} has no model id`);
  const rows = await db
    .select({ config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId));
  const current = rows[0]?.config;
  if (!current || typeof current !== 'object') {
    throw new Error(`session ${input.sessionId} has no config to record the live model switch`);
  }
  const next = { ...current };
  if (input.source === 'platform') delete next.model;
  else next.model = modelId;
  await db.update(sessions).set({ config: next }).where(eq(sessions.id, input.sessionId));
  try {
    await recordSessionPlatformModel(
      input.sessionId,
      input.source === 'platform' ? { modelId } : null,
    );
  } catch (error) {
    // 两半是同一个决定:平台记录没写上就把 config 写回原样,❌ 不留「config 说一条路、平台记录说另一条」。
    await db.update(sessions).set({ config: current }).where(eq(sessions.id, input.sessionId));
    throw error;
  }
}
