import { Archive, Pencil, Pin, PinOff, RotateCcw } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { requestSessionReload } from '@renderer/features/sessions/request-session-reload';
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import type { TabCommand } from '@renderer/features/tabs/tab-bar/tab-commands';
import { findSessionHostBridge } from '@renderer/lib/electron-api';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { useSessionViewContext } from '../session-view-context';

/**
 * 一条会话的动作 —— 置顶、重命名、重启本会话、归档(#7052)。「通用 / 编程」的手动切换已删:展示跟设置 → 通用的「终端」开关走。
 *
 * 它们原来在聊天栏标题行的「⋯」里;会话的名字搬到它自己的页签上之后,这些动作跟着名字走:那枚页签的右键
 * (spec session-page:置顶 / 重命名 / 归档在这枚页签的右键里)。两种形态的会话页签(终端 / 聊天)读同一份,
 * 确认框也只有这里一份 —— 页签是一行一行画的,框画在页签里会跟着页签卸掉。
 *
 * spec session-graph「会话页菜单只动它点名的那条会话」:页签写的是谁,动的就是谁(子会话的页签动子会话)。
 */
interface SessionActions {
  commandsFor(sessionId: string, rename: () => void): TabCommand[];
}

const SessionActionsContext = createContext<SessionActions | null>(null);

/** The commands of the session a tab names, for its right-click menu. Outside a session page: none. */
export function useSessionTabCommands(sessionId: string | undefined, rename: () => void): TabCommand[] {
  const actions = useContext(SessionActionsContext);
  if (!actions || !sessionId) return [];
  return actions.commandsFor(sessionId, rename);
}

export const SessionActionsProvider = observer(function SessionActionsProvider({ children }: { children: ReactNode }) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const showConfirm = useShowModal('confirmActionModal');

  /**
   * 「重启本会话」按下确认之前攥着的那点东西 —— **两条腿都能重启**,所以认的是会话 id(宿主按它找记录)。
   * 宿主停完再起之后两条腿都原地接上:聊天面的副本跟着会话 id 走,终端认一个与进程无关的稳定 pty id。
   */
  const [pendingReload, setPendingReload] = useState<{ sessionId: string } | null>(null);
  const [reloading, setReloading] = useState(false);

  const confirmReload = useCallback(async () => {
    const pending = pendingReload;
    if (!pending) return;
    setReloading(true);
    try {
      const result = await requestSessionReload({ sessionId: pending.sessionId, reason: 'manual' });
      if (!result.ok) {
        showConfirm({
          title: translate('task.manualReload'),
          description: result.error ?? '',
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
      }
    } finally {
      setReloading(false);
      setPendingReload(null);
    }
  }, [pendingReload, showConfirm, translate]);

  const actions = useMemo<SessionActions>(
    () => ({
      commandsFor(sessionId, rename) {
        const session = sessionRegistry.get(pageSessionId)?.sessions.get(sessionId);
        if (!session) return [];
        const pinned = session.data.isPinned ?? false;
        return [
          {
            id: 'session:pin',
            label: translate(pinned ? 'task.unpin' : 'task.pin'),
            icon: pinned ? PinOff : Pin,
            group: 'edit' as const,
            run: () => void sessionRegistry.get(sessionId)?.setSessionPinned(sessionId, !pinned),
          },
          {
            id: 'session:rename',
            label: translate('task.rename'),
            icon: Pencil,
            group: 'edit' as const,
            shortcut: 'session.tabRename' as const,
            // Inline on the tab when it can be (the tab's own field); the dialog otherwise.
            run: () => rename(),
          },
          {
            id: 'session:reload',
            label: translate('task.manualReload'),
            icon: RotateCcw,
            group: 'edit' as const,
            isAvailable: () => !reloading,
            run: () => setPendingReload({ sessionId }),
          },
          {
            id: 'session:archive',
            label: translate('task.archiveTaskTitle'),
            icon: Archive,
            group: 'edit' as const,
            run: () => requestArchiveSession({ projectId, sessionId }),
          },
        ];
      },
    }),
    [pageSessionId, projectId, reloading, translate]
  );

  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionReloadConfirm
        open={pendingReload !== null}
        onOpenChange={(next) => {
          if (!next && !reloading) setPendingReload(null);
        }}
        reason="manual"
        target={translate('task.manualReload')}
        isReloading={reloading}
        onConfirm={confirmReload}
      />
      {children}
    </SessionActionsContext.Provider>
  );
});

/**
 * 正看着的会话先过一道「就绪」:打开即确认它的平台凭据可用,开着的时候凭据过期也走同一道闸,
 * 再让下一次输入到达持着过期凭据的那一头。原来挂在聊天栏上(它那时只看一条),现在每一格正看着的会话各一份。
 */
export function SessionReadyGate({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    void rpc.sessions.ensurePlatformSessionReady(sessionId, 'sessionpage-open').then((result) => {
      if (result.status === 'failed') log.error('[sessionpage-recovery] session open recovery failed', { sessionId, error: result.error });
    }).catch((error: unknown) => {
      log.error('[sessionpage-recovery] session open recovery failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [sessionId]);
  useEffect(() => {
    const api = findSessionHostBridge();
    if (!api) return;
    return api.eventOn('session:platform-recovery-changed', (value) => {
      if (!value || typeof value !== 'object') return;
      const event = value as { sessionId?: unknown; status?: unknown };
      if (event.sessionId !== sessionId || event.status !== 'expired') return;
      void rpc.sessions.ensurePlatformSessionReady(sessionId, 'platform-expiry').then((result) => {
        if (result.status === 'failed') log.error('[sessionpage-recovery] active session expiry recovery failed', { sessionId, error: result.error });
      }).catch((error: unknown) => {
        log.error('[sessionpage-recovery] active session expiry recovery failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }, [sessionId]);
  return null;
}
