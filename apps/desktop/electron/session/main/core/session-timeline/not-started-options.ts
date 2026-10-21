import type { SessionpageSessionOptions } from '@gugu/session-core/session-record';

/**
 * #6264 一条**还没开起来**的会话(建的时候 agent 没起来)的会话选项。
 *
 * 活的选项住在运行时里,而这条会话没有运行时。❌ 为了读选项去唤醒它:唤醒不带第一句话,
 * 会把一条「没开起来、第一句还没送到」的会话起成一条空会话,第一句就此丢了。
 * 所以这里只报**建会话时选定的那个模型**(会话上记着),让输入框上的模型胶囊照样在;
 * 可选清单就是它一个 —— 开起来之前换不了,开起来之后读的是活的那一份。
 * 权限档 / 推理档不报:它们的 id 是各家运行时自己的,没有运行时就给不出对得上的那一份。
 */
export function notStartedSessionOptions(input: {
  /** harness 自家模型 id(会话配置里的 `model`)。 */
  model: string | null | undefined;
  /** 选的是咕咕提供的模型时,那个模型 id(不带前缀)。 */
  platformModelId: string | null | undefined;
  /** 模型 id → 显示名(那台机器上的模型目录;读不到就空)。 */
  names: ReadonlyMap<string, string>;
}): SessionpageSessionOptions {
  const id = input.platformModelId ? `platform:${input.platformModelId}` : input.model?.trim() || null;
  return {
    mode: null,
    effort: null,
    model: id ? { selected: id, available: [{ id, name: input.names.get(id) ?? input.platformModelId ?? id }] } : null,
  };
}
