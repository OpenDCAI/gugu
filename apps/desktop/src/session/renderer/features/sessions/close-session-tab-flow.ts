import type { TabCloseRequest, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { getSessionView } from './stores/session-selectors';

/** 这一块会话自己那枚对话页签的类型(终端形态 / 通用形态)。 */
const OWN_CONVERSATION_KINDS = new Set(['session', 'acp-chat']);

/** 问的时候怎么叫这几类页签(与「+」菜单同一套名字);App 与别的会话的页签统称「其他」。 */
const KIND_LABEL: Record<string, SessionMessageKey> = {
  'side-chat': 'workspace.sideTask',
  browser: 'workspace.browser',
  file: 'workspace.files',
  terminal: 'workspace.terminal',
  review: 'workspace.review',
  diff: 'workspace.review',
};

type PaneLike = {
  tabOrder: readonly string[];
  entries: ReadonlyMap<string, { kind: string; state: unknown }>;
  requestCloseTabs(tabIds: readonly string[]): Promise<void>;
};
type LayoutLike = { groups: ReadonlyArray<{ pane: PaneLike }> };

/**
 * spec session-page「页签」:关掉会话自己那枚页签,它还开着别的页签(侧边聊天、网页、文件、终端……)→ 问一句:
 * 「会话和页签都关」/「只关会话」,Esc / 点外面 = 不关(owner 2026-10-10:「我把会话关掉,这个会话所打开的网页和文件怎么没关掉…
 * 应该是让用户选择是否都关吧」)。只问用户单独关这一枚的那一下:一次关一排(关闭其他 / 右侧 / 全部)不问,
 * 那一排本来就要关;页签自己收掉自己(会话没了)也不问。
 * 开在这一块里的子会话那枚不问:它不是这一块的会话自己。
 */
export function confirmCloseSessionTab(
  tabSessionId: string,
  ctx: TabViewContext,
  request: TabCloseRequest
): boolean | Promise<boolean> {
  const { projectId, sessionId } = ctx as SessionTabContext;
  if (!request.alone || tabSessionId !== sessionId) return true;
  const layout = getSessionView(projectId, sessionId)?.paneLayout as LayoutLike | undefined;
  if (!layout) return true;
  const others = otherTabs(layout, sessionId);
  if (others.size === 0) return true;
  return new Promise<boolean>((resolve) => {
    // 三条路只认先到的那条:选了「会话和页签都关」要等别的页签一枚枚关完(可能各自还要问),这期间弹窗收起不能被当成「不关」。
    let decided = false;
    const decide = (close: boolean) => {
      if (decided) return;
      decided = true;
      resolve(close);
    };
    showModal('confirmActionModal', {
      title: translateSessionMessage('task.closeSessionWithTabsTitle'),
      description: translateSessionMessage('task.closeSessionWithTabsDescription', {
        count: others.size,
        kinds: kindsOf(layout, others),
      }),
      confirmLabel: translateSessionMessage('task.closeSessionAndTabs'),
      cancelLabel: translateSessionMessage('task.closeSessionOnly'),
      variant: 'default',
      onSuccess: () => {
        if (decided) return;
        decided = true;
        void closeTabs(layout, others).then(() => resolve(true));
      },
      onCancel: () => decide(true),
      onClose: () => decide(false),
    });
  });
}

/** 这一块里除了会话自己那枚以外的每一枚页签(所有格子)。 */
export function otherTabs(layout: LayoutLike, sessionId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const { pane } of layout.groups) {
    for (const id of pane.tabOrder) {
      const entry = pane.entries.get(id);
      if (!entry) continue;
      const own = OWN_CONVERSATION_KINDS.has(entry.kind) && (entry.state as { sessionId?: string } | null)?.sessionId === sessionId;
      if (!own) ids.add(id);
    }
  }
  return ids;
}

function kindsOf(layout: LayoutLike, ids: ReadonlySet<string>): string {
  const labels: string[] = [];
  for (const { pane } of layout.groups) {
    for (const id of pane.tabOrder) {
      if (!ids.has(id)) continue;
      const key = KIND_LABEL[pane.entries.get(id)?.kind ?? ''] ?? 'task.closeSessionKindOther';
      const label = translateSessionMessage(key);
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels.join(translateSessionMessage('task.closeSessionKindSeparator'));
}

/** 一格一格关:每一枚照样先问它自己(没存的文件、在跑的终端),格子关空了由布局收掉。 */
async function closeTabs(layout: LayoutLike, ids: ReadonlySet<string>): Promise<void> {
  for (const { pane } of [...layout.groups]) {
    const mine = pane.tabOrder.filter((id) => ids.has(id));
    if (mine.length > 0) await pane.requestCloseTabs(mine);
  }
}
