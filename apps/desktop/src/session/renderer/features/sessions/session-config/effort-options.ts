import type { ComposerEffortOption } from '@gugu/session-ui/react/components';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

type Options = Record<string, ComposerEffortOption>;

// resolveEffortCatalog 搬去了 shared(主进程为手机端算推理档时要同一份);这里只保旧 import 路径。
export { effortSourceFor, platformEffortFacts, resolveEffortCatalog } from '@shared/core/agents/create-efforts';

/**
 * 推理档的**规范阶梯**。档名的取值域全库就这一条有序阶梯(`none < minimal < low < medium <
 * high < xhigh < max`,models.dev 2026-08-25 全量核过:2819/2821 个带 effort 的模型都是它的
 * 子集),`ultra` 是 codex 在 max 之上自己多的一档(它同时会自动分派子任务)。
 *
 * 键就是档位 id,值是词表里那两条 key —— 这里**只登记 id 与 key 的对应**,一个字的文案都不写。
 */
const EFFORT_LABEL_KEYS = {
  // Pi calls the zero-effort rung `off`; its meaning is the same as the product's `none` label.
  off: ['taskConfig.effortNone', 'taskConfig.effortNoneHint'],
  none: ['taskConfig.effortNone', 'taskConfig.effortNoneHint'],
  minimal: ['taskConfig.effortMinimal', 'taskConfig.effortMinimalHint'],
  low: ['taskConfig.effortLow', 'taskConfig.effortLowHint'],
  medium: ['taskConfig.effortMedium', 'taskConfig.effortMediumHint'],
  high: ['taskConfig.effortHigh', 'taskConfig.effortHighHint'],
  xhigh: ['taskConfig.effortXhigh', 'taskConfig.effortXhighHint'],
  max: ['taskConfig.effortMax', 'taskConfig.effortMaxHint'],
  ultra: ['taskConfig.effortUltra', 'taskConfig.effortUltraHint'],
  ultracode: ['taskConfig.effortUltracode', 'taskConfig.effortUltracodeHint'],
} as const satisfies Record<string, readonly [SessionMessageLookupKey, SessionMessageLookupKey]>;

/**
 * 一组推理档 id 写成一句给人看的话(模型悬浮详情卡,#7056):「低 · 高 · 极高」。
 * 与下面同一条「全换或全不换」:有一个阶梯外的 id 就整句不给(null),❌ 半中半英。
 */
export function effortNamesLine(ids: readonly string[], translate: Translate): string | null {
  if (ids.length === 0 || !ids.every((id) => id in EFFORT_LABEL_KEYS)) return null;
  return ids.map((id) => translate(EFFORT_LABEL_KEYS[id as keyof typeof EFFORT_LABEL_KEYS][0])).join(' · ');
}

/**
 * 推理档下拉的档名换成词表里的词。
 *
 * **为什么需要这一步**:档名有两个来源,两个都不是产品文案 ——
 * ① 插件声明的 `effortOptions`(`packages/session-plugins/.../impl/<agent>/index.ts`)是**硬编码中文**;
 * ② 活会话 ACP 自报的 `configOptions` 里那个 `name` 是 harness 的词(通常是英文)。
 * 界面此前原样摆出来,于是英文壳下「Reasoning effort」的取值是「极高」「最高」,
 * 中文壳下换个 harness 又变回英文 —— **界面语言由数据来源决定**,那不是本地化。
 *
 * ⚠️ **全换或全不换,❌ 不许换一半**:上一次在权限档上按「这一档独一份才改名」做,
 * 结果是 5 英 1 中,比全英还糟(见 `permission-mode-options.ts` 抬头)。所以只要这份清单里
 * 出现一个阶梯外的 id(harness 自定义的档、`Thinking Off` 这类开关值),就整份原样交出去 ——
 * 阶梯外的那些咕咕手里根本没有对应的词,硬翻一半就是重蹈覆辙。
 *
 * ❌ 不改插件那份 `effortOptions`:那张表的职责是**这家引擎有哪几档**(每一档都得送得到进程),
 * 不是文案表。id 留在那儿,词归词表。
 */
export function localizeEffortOptions(
  options: Options | null,
  translate: Translate
): Options | null {
  if (!options) return null;
  const ids = Object.keys(options);
  if (ids.length === 0) return options;
  if (!ids.every((id) => id in EFFORT_LABEL_KEYS)) return options;

  const localized: Options = {};
  for (const id of ids) {
    const [nameKey, hintKey] = EFFORT_LABEL_KEYS[id as keyof typeof EFFORT_LABEL_KEYS];
    localized[id] = {
      ...options[id],
      name: translate(nameKey),
      description: translate(hintKey),
    };
  }
  return localized;
}
