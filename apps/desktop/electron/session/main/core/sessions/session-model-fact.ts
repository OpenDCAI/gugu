// @@@4616 快照里那格「这条会话跑在哪个模型上」的事实 —— 与「去哪读那条决策」分开的一小块。
//
// 单独成模块只为一件事:**让它可判据**。它的合同里有一条是「平台模型必须报出两个**不同**的
// 字符串」,而那条断言在 e2e 那侧的变异下跑不到(主断言先红)。放在 `session-orchestration.ts`
// 里就只能连整张 Electron 依赖图一起 import —— 单测当场死在 `safeStorage` 上。
// ⇒ 这里只依赖那份零 import 的 id 编码,几毫秒就能把合同的四种取值全判一遍。

import { platformOptionId } from '@shared/platform-model-id';

/**
 * 这条会话跑在哪个模型上 —— 以及那句话是**谁**说的。两条来源，不是一条：咕咕平台模型记在
 * per-session 的平台决策里（`platform-model-selection`），harness 自家的模型记在 `sessions.model`。
 * 一条平台会话的 `sessions.model` 是空的，所以只读后者会把它报成「没钉模型」。
 *
 * ⚠️ 这里报的是**咕咕为这条会话钉了什么**，不是 harness 此刻正在用什么。ACP `SessionSummary`
 * 不带模型（见 session-core 的 sessionSummarySchema），咕咕因此观察不到 agent 自己中途换模型；
 * 报一个观察不到的事实等于编。
 */
export type SessionModel = {
  /**
   * - `gugu`    跑在咕咕平台上，`id` 就是它用的模型；网关签不出这个模型时会话响亮起不来。
   * - `harness` 明确用 harness 自己的账号：`id` 是钉给它的模型，`null` = 没钉，由 harness 自己默认。
   * - `unset`   这条会话没做过这个决定（决策落地之前建的），启动时按 agent 级配置解析 ——
   *             本层报不出它最终落到哪个，所以不猜。
   */
  source: 'gugu' | 'harness' | 'unset';
  /**
   * 模型**本身**的 id —— 平台模型就是 `billing.platform_models.id`(裸的,与计费行对得上),
   * harness 模型就是它的原生 id。#4366 的合同:「`id` 就是它用的模型」。
   */
  id: string | null;
  /**
   * **往返闭合** —— 把这条会话的模型原样传回 `session_spawn` 的 `model` 时该用的取值。
   *
   * ⚠️ 它和 `id` 对平台模型**不是同一个字符串**,而这正是它存在的理由:`id` 是裸的
   * (计费身份),`session_spawn` 的取值空间是 `session_list_models` 那套带 `platform:` 前缀的
   * (两组模型共用一个命名空间,前缀是唯一分界)。少了这一格,读快照的一方只能拿 `id` 去传,
   * 落进 harness 分支 ⇒ 明确 BYOK + 一个不存在的 harness 模型,而 claude 对伪造 id 原样透传
   * 不报错 ⇒ **静默错模型**。
   *
   * ⇒ 判据:**工具吐出来的 id,必须能被自己的 API 原样吃回去。** `source: 'unset'` 时缺席 ——
   * 那条会话本来就没做过这个决定,编一个「该传什么」等于说一件没观察到的事。
   */
  spawn_model_id?: string;
};

/** 三态决策 + harness 自家那格模型 → 快照事实。纯函数,不碰数据库。 */
export function sessionModelFromDecision(
  platform: { modelId: string } | null | undefined,
  harnessModel: string | null,
): SessionModel {
  if (platform) {
    return {
      source: 'gugu',
      id: platform.modelId,
      spawn_model_id: platformOptionId(platform.modelId),
    };
  }
  // 明确选了 harness 自家模型 ⇒ 一个平台变量都不注入,会话行上那个模型就是它跑的模型
  // （harness 自家的模型记在 config 上，`conversations` 表没有 model 列）。
  if (platform === null) {
    return {
      source: 'harness',
      id: harnessModel,
      ...(harnessModel ? { spawn_model_id: harnessModel } : {}),
    };
  }
  // 没做过这个决定 ⇒ 启动时按 agent 级 model_access 解析,那份配置**可能正是一个平台模型**,
  // 它一旦解析出来就盖过会话行上的模型。所以这里连 id 都报不出:报会话行上那个,就是在说一件
  // 没观察到的事。❌ 别因为「手头正好有个字符串」就把它填上（review 实测:config.model=opus-4-6
  // 而 agent 级解析成平台模型时，填了就是界面说 A、实际跑 B）。
  return { source: 'unset', id: null };
}
