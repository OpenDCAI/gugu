/** @jsxImportSource solid-js */
/**
 * day-separator —— 长对话里的日界锚（对照表 #20 `elements-day-separator`）。
 *
 * # 它为什么是一条独立的行，而不是挂在下一条消息头上
 *
 * transcript 是离屏测量 + Fenwick 虚拟化：每一行的高度要在挂载前算出来，行的身份也要在
 * 那之前定下来。两条路都能画出同样的像素，但它们在**测量**和**锚定**上不是一回事：
 *
 * ① **测量**。做成独立 row，它的高度是自己的一个常量，`message` 那条既有的 `measure()`
 *    一个字都不用改。挂到消息头上则相反 —— 消息的高度从此取决于"我上面有没有日界"，
 *    而那是一个**由邻居决定**的输入，既不在 `MeasureCtx` 里，也不在 `data` 里。要么把它
 *    塞进 lane A（多一个测量输入，且 prepend 一批旧 turn 会让已测好的那条消息改变高度），
 *    要么它就会绕过测量 —— 后者正是 `height.contract.test.tsx` 守着的那种漂移。
 * ② **锚定**。单元按 `itemId` 定位（`ChatRoot.committedIndexById` / `scrollToItem`）。
 *    独立 row 有自己的 id，于是"跳到某条消息"仍然精确落在那条消息上；并进消息则等于
 *    偷偷改了 `scrollToItem` 的口径 —— 跳过去会先看到一条日期，那条消息被顶下去半行。
 *
 * ⇒ 选独立 row。代价是单元流里多一种 kind（`SEGMENTERS` / `UNIT_REGISTRY` 各加一项），
 * 收益是既有两条契约都不用改口径。
 *
 * # 它为什么可能一条都不出现
 *
 * 分隔行只由 `TranscriptTurn.startedAt` 划定，而那个字段在 provider replay 重建的历史上
 * **是缺席的**（合同见 `session-core/.../turns/turn.ts`）。⇒ 一段从 ACP `session/load` 恢复
 * 出来的会话没有日界行。这不是没做完：engine 不知道那些 turn 发生在哪天，
 * 而一条把上周标成今天的锚比没有锚更坏。
 *
 * # 高度：常量，不随文案变
 *
 * "今天"两个字与 "Mar 3 2025" 在这一行里占同样的高度；标签 `line-height` 固定，
 * 行根写死 `DAY_SEPARATOR_ROW_H`。⇒ 跨过午夜时文案从"今天"变成"昨天"只是 lane B 的
 * 一次重绘，不产生任何测量变化，虚拟器不需要知道这件事。
 */
import { defineUnit } from '@session-chat/core/units';
import { dayBoundaryLabel, msUntilNextLocalMidnight } from '@session-chat/lib/day-boundary';
import { useChatLocale, useChatTranslator } from '@session-chat/localization';
import type { DaySeparatorItem } from '@session-chat/model';
import { createSignal, onCleanup } from 'solid-js';
import { separatorLabel, separatorRow, separatorRule } from './day-separator.css';

/**
 * 行高（px）。发丝线居中，标签 16px 行高上下各留 4px。
 *
 * ⚠️ 改这个值必须同时改 `day-separator.css.ts` 里标签的 `line-height`，
 * 否则标签会被行根静静裁掉而高度契约仍然吻合。
 */
export const DAY_SEPARATOR_ROW_H = 24;

export const daySeparatorUnitDef = defineUnit<DaySeparatorItem, { rowH: number }>({
  kind: 'day-separator',
  // 上下都比普通 turn 间距宽一档：这一行是分节符，两边都需要呼吸。
  margin: { top: 16, bottom: 12 },
  vars: { rowH: DAY_SEPARATOR_ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const translate = useChatTranslator();
    const locale = useChatLocale();

    // 「今天／昨天」是相对现在说的，所以窗口一直开着跨过午夜时这句话会过期。
    // 一次性定时器对准下一个本地零点，到点后把 now 推进并重排下一次。
    // 虚拟化让同时挂载的分隔行只有个位数，因此按行各起一个定时器不值得再加共享层。
    const [now, setNow] = createSignal(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleMidnight = (from: number): void => {
      timer = setTimeout(() => {
        const next = Date.now();
        setNow(next);
        scheduleMidnight(next);
      }, msUntilNextLocalMidnight(from));
    };
    scheduleMidnight(now());
    onCleanup(() => clearTimeout(timer));

    const label = (): string => {
      const started = new Date(props.data.startedAt);
      const time = `${started.getHours()}:${String(started.getMinutes()).padStart(2, '0')}`;
      return `${dayBoundaryLabel(props.data.startedAt, now(), translate, locale())} ${time}`;
    };

    return (
      <div
        data-slot="day-separator"
        // 读屏按分节读，而不是把日期念成一句孤立的正文。
        role="separator"
        aria-label={translate('transcript.dayStart', { day: label() })}
        class={separatorRow}
        style={{ height: `${props.vars.rowH}px` }}
      >
        <span data-slot="day-separator-rule" aria-hidden="true" class={separatorRule} />
        <time
          data-slot="day-separator-label"
          class={separatorLabel}
          dateTime={new Date(props.data.startedAt).toISOString()}
        >
          {label()}
        </time>
        <span data-slot="day-separator-rule" aria-hidden="true" class={separatorRule} />
      </div>
    );
  },
});
