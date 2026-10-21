import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { READING_LINE, SYNTHETIC_ROW_SUFFIXES } from './session-timeline-geometry';
import { SessionTimelineRail } from './session-timeline-rail';
import type { TimelineTurn } from './session-timeline-turns';
import { useTranscriptTimeline } from './use-transcript-timeline';

/**
 * @@@sessionpage layout — conversation timeline scrubber (behavior
 * session-page 会话页). Always rendered on the chat column's left edge (#4874,
 * owner 2026-09-03: 「我要个 minimap 在左侧栏」— it used to appear only while the
 * workspace panel was collapsed). One tick per input while they
 * fit, otherwise one tick per group of turns (see below); hovering magnifies
 * nearby ticks dock-style and floats a "prompt + reply" preview card;
 * clicking jumps the transcript to that turn (AcpChatStore.scrollToItem). PTY
 * conversations have no structured transcript, so the scrubber renders null —
 * and the column reserves no rail for it (see useSessionTimelineTurns).
 *
 * Geometry, lens and preview follow the reference the owner pointed at
 * (2026-09-04, vivid-layer Chat Minimap): 12px marker rows with no gap, a 2px
 * pill that swells to 3× under the pointer with a cosine lens over 3
 * neighbours on each side, an official hover card beside the tick, and the
 * marker of the turn currently under the reading line drawn solid.
 *
 * ⚠️ 轨道长度**不跟着轮数长**(#5456):原来行高是常量 12px 又从中点往两头长,
 * 一条 260 轮的会话就是 3120px,而聊天栏只有 ~860px —— 实测(owner 2026-09-10)
 * 刻度从顶栏一直溢到窗口下沿,只有中间 70 条画在框内,会话的头和尾**点不到**,
 * 连「你在这」那枚也常在框外。现在轨道占满这一列,**它的高度决定能站下多少格**,
 * 行高钉死 12px、轮数超了就一格代表多轮(见 session-timeline-geometry 的
 * `railCapacity` / `turnsPerTick` 与 session-timeline-turns 的 `ticksFromTurns`)。
 * ❌ 不是把行距压细:那版试过,260 轮时一行 3.3px,owner:「要不弄个上限吧,现在太密了」。
 *
 * Ticks of turns that *arrived* (another agent / a person, through 咕咕) are
 * painted in the info colour and their preview names the sender; the user's
 * own turns stay neutral (owner 2026-09-04:「要看出来消息来自于谁」)。一格代表多轮时
 * 这条判在格子层面:格里有投递就整格标投递色、代表取那一条 —— 否则投递被埋在格中间
 * 就整格看不出来。
 */

/**
 * The ticks the rail would draw right now. Shared with the chat column so the
 * 24px rail lane is reserved exactly when a rail is drawn — never an empty
 * gutter beside a PTY session or an unstarted conversation.
 *
 * The resource lookup is MobX-backed; the timeline itself subscribes to the
 * Solid transcript so it also follows in-flight input and reply text changes.
 */
function useSessionTimelineProjection<T>(
  sessionId: string | undefined,
  select: (turns: TimelineTurn[]) => T,
): T {
  const session = sessionId
    ? sessionRegistry.get(sessionId)?.sessions.get(sessionId)
    : undefined;
  void session?.status;
  const store = sessionId ? findAcpChatStore(sessionId) : undefined;
  void store?.messageCount;
  return useTranscriptTimeline(store?.chatState.transcript, getSharedChatContext().selfIdentity, select, store?.chatState.session);
}

const selectTurns = (turns: TimelineTurn[]) => turns;
const selectHasTurns = (turns: TimelineTurn[]) => turns.length > 0;

export function useSessionTimelineTurns(sessionId: string | undefined) {
  return useSessionTimelineProjection(sessionId, selectTurns);
}

/** The column only needs presence; streaming text must not rerender its whole workbench. */
export function useSessionTimelinePresence(sessionId: string | undefined) {
  return useSessionTimelineProjection(sessionId, selectHasTurns);
}

/**
 * The turn under the reading line, read off the transcript DOM. The engine
 * owns scrolling and virtualisation and exposes no「current anchor」, so the
 * rail listens for scroll in the capture phase on its own parent — scroll
 * does not bubble, but it does capture, and this survives the chat root
 * remounting (layout switch, conversation switch) without re-subscribing.
 * Rows carry `data-item-id`; `turns[].itemIds` maps them back to a turn.
 *
 * Scroll alone is not enough: rows land *after* the turns do (replay seeds
 * the store, Solid paints on a later frame), and a transcript shorter than
 * the viewport never scrolls at all — so the first reading would find no
 * rows and nothing would ever re-read it (seen on the real app 2026-09-04:
 * no tick current until a synthetic scroll event). A MutationObserver on the
 * same parent re-reads whenever the transcript DOM changes; both feed one
 * rAF-throttled read.
 */
function useReadingTurn(
  navRef: React.RefObject<HTMLElement | null>,
  turns: TimelineTurn[]
): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const signature = turns.map((turn) => `${turn.id}:${turn.itemIds.length}`).join('|');
  useEffect(() => {
    const host = navRef.current?.parentElement;
    if (!host) return;
    const turnOfItem = new Map<string, string>();
    for (const turn of turnsRef.current) {
      for (const itemId of turn.itemIds) turnOfItem.set(itemId, turn.id);
      const sourceId = turn.sourceTurnId ?? turn.id;
      for (const suffix of SYNTHETIC_ROW_SUFFIXES) {
        const rowId = `${sourceId}:${suffix}`;
        // The opening header belongs to the first input; a running/outcome
        // footer belongs to the last input in that provider turn.
        if (!turnOfItem.has(rowId) || suffix === 'working' || suffix === 'outcome') {
          turnOfItem.set(rowId, turn.id);
        }
      }
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]');
      if (!scroller) return;
      const line = scroller.getBoundingClientRect().top + READING_LINE;
      let best: string | null = null;
      let bestBottom = Number.POSITIVE_INFINITY;
      for (const row of scroller.querySelectorAll<HTMLElement>('[data-item-id]')) {
        const bottom = row.getBoundingClientRect().bottom;
        if (bottom <= line || bottom >= bestBottom) continue;
        const turn = turnOfItem.get(row.dataset.itemId ?? '');
        if (!turn) continue;
        best = turn;
        bestBottom = bottom;
      }
      setCurrent(best);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const observer = new MutationObserver(onScroll);
    observer.observe(host, { childList: true, subtree: true });
    read();
    return () => {
      observer.disconnect();
      host.removeEventListener('scroll', onScroll, { capture: true });
      if (frame) cancelAnimationFrame(frame);
    };
  }, [navRef, signature]);
  return current;
}

export const SessionTimeline = observer(function SessionTimeline({
  sessionId,
}: {
  sessionId: string;
}) {
  // Read the same live transcript as the chat column.
  const turns = useSessionTimelineTurns(sessionId);
  const store = findAcpChatStore(sessionId);
  const navRef = useRef<HTMLElement | null>(null);
  const currentTurnId = useReadingTurn(navRef, turns);

  return (
    <SessionTimelineRail
      turns={turns}
      currentTurnId={currentTurnId}
      onJump={(anchorItemId) => store?.scrollToItem(anchorItemId)}
      railRef={navRef}
    />
  );
});
