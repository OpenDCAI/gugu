import { platformModelIdFromOption, platformOptionId } from '@/session/shared/platform-model-id';
import {
  runningPlatformModelId,
  type PersistedSessionSelection,
} from '../session-config/platform-model-selection';

/**
 * spec session-terminal-model-switch —— 终端会话顶栏换模型的两个判断，抽成纯函数以便能被判假。
 *
 * 终端会话没有活的 ACP 清单可以「热切」:harness 的 TUI 自己握着进程,咕咕只在 spawn 那一刻注入
 * 凭据与模型。⇒ 顶栏上**任何**一次换模型都是「确认 → 宿主按新记录重开 → 续上同一条会话」,
 * 不分同来源还是跨来源。通用模式那张 `planModelSwitch` 四态表在这里只剩两态。
 */

/**
 * 顶栏该高亮哪一条 —— 与通用模式同一套读回规则(`composerSelectedOptionId`:平台那一路优先)。
 * 这里直接用无 React 的编解码模块,好让本文件能在 node 里被测;编码本身仍只有那一份。
 */
export function terminalSelectedOptionId(input: {
  /** 会话记下的计费路决定:`{modelId}` 咕咕代付 / `null` 明确 BYOK / `undefined` 没做过这个决定。 */
  sessionSelection: PersistedSessionSelection;
  platformModelIds: readonly string[];
  /** 会话记录里的 `model`(BYOK 那一路的模型;缺席 = harness 自家默认)。 */
  recordedModel?: string | null;
}): string | undefined {
  const platformModel = runningPlatformModelId(
    input.sessionSelection,
    null,
    input.platformModelIds,
  );
  if (platformModel) return platformOptionId(platformModel);
  // 平台那一路时宿主会把 config.model 删掉;万一残留,也由上面平台那一格优先。
  return input.recordedModel?.trim() || undefined;
}

/**
 * 思考档位随重开一起落库的三态:字符串 = 换成这一档;`null` = 清掉、回到 harness 默认;
 * 缺席 = 不碰(沿用记录里那一档)。
 */
export type TerminalEffortChange = string | null | undefined;

export type TerminalModelSwitch =
  | { kind: 'none' }
  | {
      kind: 'reload';
      model?: { id: string; source: 'platform' | 'own' };
      effort?: TerminalEffortChange;
      label: string;
    };

/**
 * 用户在顶栏清单里点了一条 → 要不要重开、带着什么重开。
 *
 * - 点的就是正在跑的那条 ⇒ 什么都不做(❌ 为一次「没变」打断用户的回合)。
 * - 清单里没有 / 置灰的 ⇒ 什么都不做:置灰行本来就点不中,到这里说明界面状态过期。
 * - 其余一律 `reload`,带上**计费路**:宿主 spawn 读的是每会话那份平台记录,少了它会带着旧的
 *   那条路重开(见 `SessionReloadRequest.modelSource`)。
 */
export function planTerminalModelSwitch(input: {
  optionId: string;
  selectedOptionId: string | undefined;
  options: Record<string, { name: string; disabled?: boolean }> | null;
  /** 记录里正在用的思考档位(没选过 = undefined)。 */
  recordedEffort?: string | null;
  /** 换过去之后那个模型能选的档位;null = 新模型没有这根轴。 */
  targetEffortIds?: readonly string[] | null;
}): TerminalModelSwitch {
  if (input.optionId === input.selectedOptionId) return { kind: 'none' };
  const option = input.options?.[input.optionId];
  if (!option || option.disabled) return { kind: 'none' };
  const platformId = platformModelIdFromOption(input.optionId);
  const model =
    platformId === null
      ? { id: input.optionId, source: 'own' as const }
      : { id: platformId, source: 'platform' as const };
  const effort = carryEffort(input.recordedEffort, input.targetEffortIds ?? null);
  return {
    kind: 'reload',
    model,
    ...(effort !== undefined ? { effort } : {}),
    label: option.name,
  };
}

/**
 * 换模型时思考档位怎么办:新模型也有这一档 ⇒ 不碰(沿用);没有 ⇒ 清掉回默认。
 * ❌ 不把一个新模型不认的档位带进 spawn —— claude 的 `--effort`、codex 的
 * `model_reasoning_effort` 拿到不认的值会直接起不来或被静默忽略,两种都是「界面说的与实际跑的不一致」。
 */
export function carryEffort(
  recordedEffort: string | null | undefined,
  targetEffortIds: readonly string[] | null,
): TerminalEffortChange {
  const current = recordedEffort?.trim();
  if (!current) return undefined;
  return targetEffortIds?.includes(current) ? undefined : null;
}

/**
 * 用户在顶栏卡片里拖/点了思考档位 → 要不要重开。
 *
 * - `''`(卡片上的复位钮)与 `default` 那一档:清掉、回 harness 默认;本来就没选过就什么都不做。
 * - 与正在用的那一档相同、或清单里没有 ⇒ 什么都不做。
 * - 其余 ⇒ 带着新档位重开,模型不动。
 */
export function planTerminalEffortSwitch(input: {
  effortId: string;
  recordedEffort: string | null | undefined;
  options: Record<string, { name: string; disabled?: boolean }> | null;
}): { kind: 'none' } | { kind: 'reload'; effort: string | null; effortName: string | null } {
  const current = input.recordedEffort?.trim() || null;
  // harness 经 ACP 报上来的「default」一档意思就是「用 harness 自己的默认」,不是一个档位值:
  // 终端走 argv,`claude --effort default` 实测被当成未知值忽略并告警。⇒ 与复位钮同义,清掉。
  if (input.effortId === '' || input.effortId === 'default') {
    return current === null ? { kind: 'none' } : { kind: 'reload', effort: null, effortName: null };
  }
  if (input.effortId === current) return { kind: 'none' };
  const option = input.options?.[input.effortId];
  if (!option || option.disabled) return { kind: 'none' };
  return { kind: 'reload', effort: input.effortId, effortName: option.name };
}
