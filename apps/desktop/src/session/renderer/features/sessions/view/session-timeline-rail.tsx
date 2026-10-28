import { useLayoutEffect, useRef, useState } from 'react';
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from '@renderer/lib/ui/preview-card';
import { cn } from '@renderer/utils/utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  DELIVERY_PILL_LENGTH,
  ITEM_SIZE,
  MAGNIFICATION,
  OWN_PILL_LENGTH,
  PILL_WIDTH,
  RUN_PILL_WIDTH,
  markerWidth,
  railCapacity,
} from './session-timeline-geometry';
import { DELIVERY_RUN_MIN, ticksFromTurns, type TimelineSender, type TimelineTick, type TimelineTurn } from './session-timeline-turns';
import { chatDisplayName } from '@renderer/lib/chat/chat-name';

/**
 * The rail itself: ticks, lens and preview cards, given the turns. Split from
 * `SessionTimeline` (which owns the store reads and the reading line) so
 * 「一条 260 轮的会话画成什么样」判得起来 —— 疏密与框内框外都是**布局**属性,
 * 只有真 Chromium 说得清,而挂 `SessionTimeline` 要连上 sessionRegistry
 * 与整条 transcript。判据在 `tests/browser/session-timeline-overflow-5456.test.tsx`。
 */
type Translate = ReturnType<typeof useSessionMessages>['translate'];

function senderLabel(sender: TimelineSender | undefined, translate: Translate): string {
  if (!sender) return translate('task.timelineYou');
  switch (sender.kind) {
    case 'gugu':
      return translate('transcript.deliveryLegacySender');
    case 'session':
      return `${sender.name} · ${translate('transcript.deliveryViaSession')}`;
    case 'extension':
      return `${sender.name} · ${translate('transcript.deliveryViaExtension')}`;
    case 'forum':
      return `${sender.name} · ${translate('transcript.deliveryViaForum')}`;
    case 'group':
      return `${sender.name} · ${((chat) => chat ? translate('transcript.deliveryViaGroup', { chat }) : translate('transcript.deliveryViaUnnamedGroup'))(sender.chatId ? chatDisplayName(sender.chatId) : null)}`;
    case 'chat':
      return `${sender.name} · ${translate('transcript.deliveryViaChat')}`;
  }
}

/** 「N 条投递 · 来自 A、B、C(等)」:发送者去重、按出现先后,最多点三个名字。 */
function runHeading(tick: TimelineTick, translate: Translate): string {
  const names = tick.senders.map((sender) => (sender.kind === 'gugu' ? translate('transcript.deliveryLegacySender') : sender.name));
  const shown = names.slice(0, 3).join(translate('task.timelineSenderSeparator'));
  return translate(names.length > 3 ? 'task.timelineDeliveryRunMore' : 'task.timelineDeliveryRun', { count: tick.deliveries, senders: shown });
}

export function SessionTimelineRail({
  turns,
  currentTurnId,
  onJump,
  railRef,
}: {
  turns: TimelineTurn[];
  /** The turn under the reading line; its tick is drawn solid. */
  currentTurnId: string | null;
  onJump: (anchorItemId: string) => void;
  /** `SessionTimeline` reads the reading line off this node's parent. */
  railRef?: React.RefObject<HTMLElement | null>;
}) {
  const { translate } = useSessionMessages();
  const ownRef = useRef<HTMLElement | null>(null);
  const navRef = railRef ?? ownRef;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // 轨高只有量出来才知道 —— 它跟着窗口、侧栏、工作区面板一起变,而一格代表几轮全看它。
  // ⚠️ 用 layout effect 先量一次:量到之后才知道格数,放到 useEffect 里就会先按「一轮一格」
  // 画一帧,长会话那一帧是真的溢出。依赖写 `hasTurns` —— 轨是从 0 轮长出来的,`[]` 会让
  // observer 永远挂不上后来才出现的那个 nav。
  const [railHeight, setRailHeight] = useState(0);
  const hasTurns = turns.length > 0;
  useLayoutEffect(() => {
    const rail = navRef.current;
    if (!rail) return;
    setRailHeight(rail.clientHeight);
    const observer = new ResizeObserver((entries) => {
      setRailHeight(entries[entries.length - 1]?.contentRect.height ?? 0);
    });
    observer.observe(rail);
    return () => observer.disconnect();
  }, [navRef, hasTurns]);

  if (turns.length === 0) return null;

  const ticks = ticksFromTurns(turns, railCapacity(railHeight));
  const currentIndex = currentTurnId ? turns.findIndex((turn) => turn.id === currentTurnId) : -1;

  return (
    <nav
      ref={navRef}
      data-region="session-timeline"
      aria-label={translate('task.timelineLabel')}
      // inset-y-0 + justify-center:轨道**就是**这一列的高度,格数由它算出来,所以永远落在框内。
      // ❌ top-1/2 + -translate-y-1/2 —— 那是让一条「内容高度」的轨从中点往两头长,越长越出框。
      // 轨占满整列后自己不吃指针事件,否则那 36px 宽的空白车道会替 transcript 挡掉点击。
      className="pointer-events-none absolute inset-y-0 left-3 z-10 flex flex-col items-start justify-center"
    >
      {ticks.map((tick, index) => {
        const { turn } = tick;
        const spansMany = tick.to > tick.from;
        const isCurrent = currentIndex >= 0 && currentIndex + 1 >= tick.from && currentIndex + 1 <= tick.to;
        const label = senderLabel(turn.sender, translate);
        const range = translate('task.timelineTurnRange', { from: tick.from, to: tick.to });
        // 一格全是投递、而且够一段(连续 ≥ DELIVERY_RUN_MIN 条合成的):画成更粗更淡的一段,预览卡写「N 条投递 · 来自 …」。
        const run = !tick.mine && tick.deliveries >= DELIVERY_RUN_MIN;
        // design.md:blue 只表示 live/running/connected/**currently selected**,所以「我说的」靠墨与长度区分,
        // ❌ 不拿蓝(owner 2026-10-28 定方案 A):你的话满墨加长;投递短而淡;连续投递那一段更粗更淡。
        // isCurrent 一件事拿蓝,只换颜色,长短粗细照旧 —— 正在读的那一格也看得出是谁的。
        const tone = isCurrent
          ? 'bg-foreground-info'
          : tick.mine
            ? 'bg-foreground'
            : run
              ? 'bg-foreground-muted/25 group-hover:bg-foreground-muted group-focus-visible:bg-foreground-muted'
              : 'bg-foreground-muted/35 group-hover:bg-foreground-muted group-focus-visible:bg-foreground-muted';
        const restLength = tick.mine ? OWN_PILL_LENGTH : DELIVERY_PILL_LENGTH;
        const heading = run ? runHeading(tick, translate) : tick.mine ? translate('task.timelineYou') : label;
        const jumpLabel = run
          ? translate('task.jumpToDeliveryRun', { count: tick.deliveries, prompt: turn.prompt.slice(0, 50) })
          : tick.mine
            ? translate('task.jumpToTurn', { prompt: turn.prompt.slice(0, 50) })
            : translate('task.jumpToDelivery', { sender: label, prompt: turn.prompt.slice(0, 50) });
        return (
          <PreviewCard key={turn.id}>
            <PreviewCardTrigger
              delay={100}
              closeDelay={100}
              render={
                <button
                  type="button"
                  // 一格代表多轮时读屏也要说清它覆盖了哪几轮 —— 否则「跳到这一轮」这句是假的。
                  aria-label={spansMany ? `${range} · ${jumpLabel}` : jumpLabel}
                  aria-current={isCurrent ? 'location' : undefined}
                  data-tick-index={index}
                  data-tick-span={`${tick.from}-${tick.to}`}
                  data-tick-current={isCurrent ? 'true' : undefined}
                  data-tick-sender={turn.sender?.kind}
                  data-tick-kind={tick.mine ? 'mine' : run ? 'run' : 'delivery'}
                  className="group pointer-events-auto flex items-center rounded-sm outline-none"
                  style={{ height: ITEM_SIZE, width: ITEM_SIZE * MAGNIFICATION }}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onFocus={() => setHoveredIndex(index)}
                  onBlur={() => setHoveredIndex(null)}
                  onClick={() => onJump(turn.anchorItemId)}
                />
              }
            >
              <span
                data-slot="tick"
                className={cn(
                  'rounded-full transition-[width,background-color] duration-[var(--dur-med)] ease-out motion-reduce:transition-none',
                  tone
                )}
                style={{ width: markerWidth(index, hoveredIndex, restLength), height: run ? RUN_PILL_WIDTH : PILL_WIDTH }}
              />
            </PreviewCardTrigger>
            <PreviewCardContent side="right" sideOffset={8} className="w-72">
              <div
                data-slot="preview-sender"
                className={cn(
                  'flex items-center gap-1 text-xs',
                  // 同一条法:来源不是活的,不拿蓝 —— 你的话满墨,投递用次一级的墨(见上方 tone)。
                  tick.mine ? 'font-medium text-foreground' : 'text-foreground-muted'
                )}
              >
                <span className="truncate">{heading}</span>
                {/* 这一格代表多轮时才写出轮次区间:一格一轮的会话不该多出一行没用的元信息。 */}
                {spansMany && (
                  <span data-slot="preview-range" className="ml-auto shrink-0 tabular-nums">
                    {range}
                  </span>
                )}
              </div>
              {/* 有你的一轮的格子按你的画;同格还有投递就说一声,❌ 让它们无声消失。 */}
              {tick.mine && tick.deliveries > 0 && (
                <p data-slot="preview-also" className="text-xs text-foreground-muted">
                  {translate('task.timelineAlsoDeliveries', { count: tick.deliveries })}
                </p>
              )}
              <p className="line-clamp-2 text-sm font-medium">{turn.prompt}</p>
              {turn.reply && <p className="line-clamp-4 text-xs text-foreground-muted">{turn.reply}</p>}
            </PreviewCardContent>
          </PreviewCard>
        );
      })}
    </nav>
  );
}
