/** @jsxImportSource solid-js */
/**
 * turn-process — 一轮工作的时间头(#4874 → #4981)。
 *
 * 跑着的时候「已处理 16s」在数、带微光,底下的内容默认摊开;落定后同一条头默认收起,
 * 写的是总时长「用时 42s ›」(owner 2026-09-06:「时间头本身算是过程的折叠,只不过是
 * 运行完成后,时间头是对过程的折叠」「结束后用用时来表达吧」)。❌ 不写步数:「过程我不关心几步,我关心的是运行多长时间」。
 *
 * 展开不会长高这一行 —— flatten 在它下面重新发出被折起来的单元 —— 所以 measure()
 * 是一个常数头高,这一行自己没有过渡动画。
 *
 * 一轮开始了、还没有可折的过程时,它也是这一行(`placeholderTurnHeader`):写「正在思考…」占着位置,
 * 过程一出现就落在它下面、它接着数「已处理 Ns」—— 中途 ❌ 撤掉再冒出来(owner 2026-10-23)。
 *
 * 同屏只让一处在动:底下有内容(`withBody`)时头只数秒、不带微光 —— 底下活着的那些行自己带着;头再一起扫,
 * 两三处同时亮暗就是「不断闪烁」(owner 2026-10-22)。数秒时数字等宽(见 `turnProcessHeaderSlot`),头上的字与箭头不挪窝。
 *
 * 计时的起点是 `TranscriptTurn.startedAt`(事件到达时刻,存在数据里):虚拟列表把行滚出
 * 视窗就卸载,拿挂载时刻当起点的话滚回来会从 0 重数;拿会话级「首次见到」当起点,打开一个
 * 已经跑了五分钟的会话时会说 3 秒。回放来的一轮没有时刻,那就不写时间
 * —— 一个会少报的计时器比没有计时器更糟。
 */
import { HEADER_ROW_EXTRA_H } from '@session-chat/components/engine/row-metrics';
import { useTheme } from '@session-chat/components/contexts/ThemeContext';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { TurnProcessItem } from '@session-chat/model';
import { turnProcessExpanded, turnProcessLabel } from '@session-chat/state/turn-fold';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { conversationHeader, conversationName, conversationTime } from '../message/conversation-message.css';
import { ConversationProcess } from '../message/ConversationProcess';
import { ProcessBackgroundList, ProcessBackgroundPill, backgroundHeight } from '../message/ConversationMessage';
import { CONVERSATION_HEADER_H, CONVERSATION_PROCESS_H } from '../message/conversation-body';
import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { turnProcessHeaderSlot, turnProcessLine, turnProcessRow } from './turn-process.css';

export const turnProcessUnitDef = defineUnit<TurnProcessItem, { extraH: number }>({
  kind: 'turn-process',
  margin: { top: 4, bottom: 4 },
  vars: { extraH: HEADER_ROW_EXTRA_H },

  measure(_data, ctx, vars_) {
    // 对话布局:名字一行 + 过程行,与回复里的那两行一样高 —— 原先按经典头的「一行正文 + 8」再加名字,过程行下面多出一截空白(owner 10-28 第 3 处)。
    if (ctx.theme.layout.agentConversation) return CONVERSATION_HEADER_H + CONVERSATION_PROCESS_H + backgroundHeight(_data, ctx);
    return ctx.theme.fonts.body.lineHeight + vars_.extraH;
  },

  Render(props) {
    const translate = useChatTranslator();
    const theme = useTheme();
    const commands = useCommands();
    const height = () => theme().fonts.body.lineHeight + props.vars.extraH;
    const rowHeight = () => theme().layout.agentConversation
      ? CONVERSATION_HEADER_H + CONVERSATION_PROCESS_H + (props.ctx.measureCtx ? backgroundHeight(props.data, props.ctx.measureCtx()) : 0) : height();
    // ViewState keeps the inverted flag inherited from the original store:
    // `isCollapsed(id) === true` means "toggled" (see view-state.ts).
    const expanded = () => turnProcessExpanded(props.data.live, props.ctx.viewState.isCollapsed(props.data.id));

    // 跑着的时候每秒数一次;落定后不再数。
    // effect 只跟「该不该数」这一个布尔(memo 去重):流式期间 `props.data` 一直在换,直接读它的 effect
    // 会每来一片就重跑一次。定时器挂在那一次 effect 上(effect 内 onCleanup)⇒ 任何时刻至多一个。
    // ❌ 拿外层变量接 setInterval 的返回值:重跑会覆盖它,前一个再也清不掉,每秒一跳、永远活着,
    // 还把整棵已卸载的转录(ChatRoot + DOM)钉在内存里。
    const [now, setNow] = createSignal(Date.now());
    const ticking = createMemo(() => !theme().layout.agentConversation && props.data.live === true && props.data.startedAt !== undefined);
    createEffect(() => {
      if (!ticking()) return;
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });

    const label = () => turnProcessLabel(props.data, now(), translate);

    return (
      <div
        data-slot="turn-process"
        data-turn-id={props.data.turnId}
        data-live={props.data.live ? 'true' : 'false'}
        data-expanded={expanded() ? 'true' : 'false'}
        class={turnProcessRow}
        style={{ height: `${rowHeight()}px` }}
      >
        <Show when={theme().layout.agentConversation}>
          <div class={conversationHeader} style={{ height: `${CONVERSATION_HEADER_H}px` }}><span class={conversationName}>{commands().conversationAgentName?.() ?? 'Agent'}</span></div>
        </Show>
        {/* 对话布局:过程行与回复头里那一行同一个样式(conversationTime)—— ❌ 套经典头的 turnProcessLine / 头槽,
            出正文前后字号 14→12、左右半边差 4px(真机验收 10-28)。 */}
        <Show when={theme().layout.agentConversation} fallback={
          <div class={turnProcessLine} data-slot="tool-timeline-line">
            <div class={turnProcessHeaderSlot}>
              <CollapseHeader
                id={props.data.id}
                collapsible={!props.data.placeholder}
                expanded={expanded()}
                active={props.data.live && !props.data.withBody}
                height={height()}
              >
                {label()}
              </CollapseHeader>
            </div>
          </div>
        }>
          <div class={conversationTime} data-slot="tool-timeline-line" style={{ height: `${CONVERSATION_PROCESS_H}px` }}>
            <ConversationProcess process={props.data} anchorId={props.data.id} expanded={expanded()} collapsible={!props.data.placeholder} />
            <ProcessBackgroundPill ownerId={props.data.id} ctx={props.ctx} />
          </div>
        </Show>
        <Show when={theme().layout.agentConversation}><ProcessBackgroundList ownerId={props.data.id} ctx={props.ctx} /></Show>
      </div>
    );
  },
});
