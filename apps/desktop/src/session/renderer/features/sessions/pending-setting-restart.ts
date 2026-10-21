import type { SessionReloadReasonCode } from '@/session/shared/core/agents/session-reload';
import type { SessionReloadReason } from './session-reload-confirm';

/**
 * 「这一维要重开会话才换得成」这件事的**唯一**表示法,以及它到重开请求的**唯一**翻译。
 *
 * ## 为什么要有这一个文件
 *
 * 三维(模型 / 权限档 / 思考档)撞到「必须重开」时,用户要的东西是同一件:**当面给他那个动作**。
 * 而实现上很容易长成三套:各自一个 `pending*` 状态、各自一个确认框、各自往请求体里塞自己的字段。
 * 三套的下场不是「有点重复」,而是**其中一处漏掉目标值**,于是重开完跑的是旧设置,
 * 而界面显示的是新设置 —— 不报错、看起来成功。
 *
 * ⇒ 所以「**哪一维、目标值是什么**」只在这里知道一次:
 *   · `RestartTarget` 是那个状态的唯一形状;
 *   · `reloadRequestFor` 是它到 `requestSessionReload` 载荷的唯一翻译;
 *   · `confirmReasonFor` 是它到确认框措辞的唯一映射。
 * 调用点(`acp-chat-panel`)因此只有一个 pending 状态、一个确认框、一个 confirm 函数。
 * ❌ 别在确认框 / 请求体 / 宿主三处各写一份 `switch (dimension)`。
 *
 * ## ⚠️ 模型那一维为什么多带一格
 *
 * `model` 要带 `source`(计费路)。那不是冗余:spawn 侧读的是每会话那份平台记录,
 * 少了它重开会带着**旧的**那条计费路重来(换到自己的模型 ⇒ 仍连咕咕端点带咕咕票 ⇒ 下一轮 403;
 * 换到咕咕的模型 ⇒ 一个平台变量都不注入)。见 `session-reload.ts` 的 `modelSource`。
 * 另两维没有这个轴 —— 这正是它们不该被塞进同一个字段的原因。
 */
export type RestartTarget =
  { dimension: 'model'; value: string; label: string; source: 'platform' | 'own' };

/** 这次重开在日志与遥测里记成哪一种(枚举,❌ 不是自由文本)。 */
export function reloadReasonCodeFor(_target: RestartTarget): SessionReloadReasonCode {
  return 'model-switch';
}

/** 确认框的措辞档 —— 组件按它选标题,调用方不写文案。 */
export function confirmReasonFor(_target: RestartTarget): SessionReloadReason {
  return 'model-switch';
}

/**
 * `requestSessionReload` 的载荷 —— **唯一**一处把维度翻译成请求字段。
 *
 * ⚠️ 目标值一定要在这里出现:一个「只重开、不带值」的请求会**重开回旧设置**,
 * 而那是这条路最难发现的失败(没有报错,界面上还显示着新值)。
 */
export function reloadRequestFor(
  target: RestartTarget,
  sessionId: string,
): {
  sessionId: string;
  reason: SessionReloadReasonCode;
  model?: string;
  modelSource?: 'platform' | 'own';
} {
  return {
    sessionId,
    reason: reloadReasonCodeFor(target),
    model: target.value,
    modelSource: target.source,
  };
}
