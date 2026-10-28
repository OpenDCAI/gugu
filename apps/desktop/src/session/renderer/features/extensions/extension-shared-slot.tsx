import { useContext, useLayoutEffect, useRef } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { AppPeekSlot } from '@/components/appSlot/AppPeekSlot';
import { ExtensionTabToolbar } from './extension-tab-toolbar';
import { extensionViewStore } from './extension-view-store';

/**
 * 常驻扩展在一条会话页里的那一格:**只是一个位置**,页不在这里。
 *
 * 页在根层(extension-view-layer),整个 app 一张;这里挂上时把自己登记成它的落点,
 * 卸下时释放。切会话 = 旧会话的格卸下、新会话的格挂上,页跟着挪过去,不重建、不闪。
 * 工具栏仍由宿主在这里画 —— 它是这一格的家具,按下去的命令经登记表找到那张页。
 */
export function ExtensionSharedSlot({
  tabKind,
  sessionId,
  chatId,
  itemId,
  tabId,
  perSession = false,
}: {
  tabKind: string;
  /** Absent: the slot is in no session (the rail's App page before any session is looked at). */
  sessionId?: string;
  /** A chat owns its own resident page, independently of task placement. */
  chatId?: string;
  /** The chat file it was opened for: a page made for that file (a chat's file in a block of its own). */
  itemId?: string;
  tabId: string;
  /** The tab is one per task (manifest `perSession`): this slot holds that task's own page, not the App's one page. */
  perSession?: boolean;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  // A retained session page that is hidden keeps this slot mounted, but must not hold the App page: the
  // root layer only re-places it on a claim change, so a hidden claim would leave it drawn over the
  // session now shown. Claim while shown, release when hidden — the page itself stays in the root layer.
  const shown = useContext(PageShownContext);

  // Where it is, and nothing else: the session's own facts (its agent, project, working copy) are main's to read
  // (真源原则 13), and what is on screen is `getAppState()`'s.
  useLayoutEffect(() => {
    const element = slotRef.current;
    if (!element || !shown) return;
    const token = extensionViewStore.claim(tabKind, { ...(sessionId ? { sessionId } : {}), ...(chatId ? { chatId } : {}), ...(itemId ? { itemId } : {}), ...(perSession ? { perSession } : {}), tabId, element });
    return () => extensionViewStore.release(tabKind, token);
  }, [tabKind, sessionId, chatId, itemId, tabId, shown, perSession]);

  return (
    <div className="flex h-full w-full flex-col">
      <ExtensionTabToolbar tabKind={tabKind} sessionId={sessionId ?? null} tabId={tabId} />
      {/* What the page opens beside it (G1) goes in this slot too: side by side, or over it when narrow. */}
      <AppPeekSlot sessionId={sessionId ?? null} tabId={tabId}>
        <div ref={slotRef} className="min-h-0 flex-1 bg-background" />
      </AppPeekSlot>
    </div>
  );
}
