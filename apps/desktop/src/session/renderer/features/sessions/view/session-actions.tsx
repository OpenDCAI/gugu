import { Archive, MessageSquare, Pencil, Pin, PinOff, RotateCcw, Terminal } from '@/lib/icons';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { requestSessionReload } from '@renderer/features/sessions/request-session-reload';
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm';
import { sessionTabKind } from '@renderer/features/sessions/session-tab-kind';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { sessionViewRequests } from '@renderer/features/sessions/stores/session-view-requests';
import type { TabCommand } from '@renderer/features/tabs/tab-bar/tab-commands';
import { findSessionHostBridge } from '@renderer/lib/electron-api';
import { rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { agentOffersSessionView } from '@shared/core/agents/agent-payload';
import { sessionRuntimeOfView, sessionViewOfRuntime, type SessionView } from '@shared/core/sessions/sessions';
import { useSessionViewContext, useWorkspaceViewModel } from '../session-view-context';
import { replaceSessionTab } from './session-pane-policy';

/**
 * 一条会话的动作 —— 置顶、重命名、重启本会话、换一种展示重开、归档(#7052)。
 *
 * 它们原来在聊天栏标题行的「⋯」里;会话的名字搬到它自己的页签上之后,这些动作跟着名字走:那枚页签的右键
 * (spec session-page:置顶 / 重命名 / 归档在这枚页签的右键里)。两种形态的会话页签(编程 / 通用)读同一份,
 * 确认框也只有这里一份 —— 页签是一行一行画的,框画在页签里会跟着页签卸掉。
 *
 * spec session-graph「会话页菜单只动它点名的那条会话」:页签写的是谁,动的就是谁(子会话的页签动子会话)。
 */
interface SessionActions {
  commandsFor(sessionId: string, rename: () => void): TabCommand[];
  /** 这条会话现在是哪种展示、每种展示选不选得了(模式按钮 #7167)。会话不在这一页 → null。 */
  viewState(sessionId: string): SessionViewState | null;
  /** 换成那种展示:先过确认框(与页签右键「切换为X模式」同一个框);选不了就说原因,不进框。 */
  requestView(sessionId: string, view: SessionView): void;
}

/** `lockOf(view)` = 这种展示为什么选不了(给人看的原话),null = 选得了。 */
export interface SessionViewState {
  view: SessionView;
  lockOf(view: SessionView): string | null;
}

const SessionActionsContext = createContext<SessionActions | null>(null);

/** 模式按钮读这一份:现在的展示、哪种选不了,以及「换」这个动作。Outside a session page: null. */
export function useSessionViewSwitch(sessionId: string | undefined): (SessionViewState & { request(view: SessionView): void }) | null {
  const actions = useContext(SessionActionsContext);
  if (!actions || !sessionId) return null;
  const state = actions.viewState(sessionId);
  return state ? { ...state, request: (view) => actions.requestView(sessionId, view) } : null;
}

/** The commands of the session a tab names, for its right-click menu. Outside a session page: none. */
export function useSessionTabCommands(sessionId: string | undefined, rename: () => void): TabCommand[] {
  const actions = useContext(SessionActionsContext);
  if (!actions || !sessionId) return [];
  return actions.commandsFor(sessionId, rename);
}

export const SessionActionsProvider = observer(function SessionActionsProvider({ children }: { children: ReactNode }) {
  const { translate } = useSessionMessages();
  const { data: agents } = useAgents();
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const { paneLayout } = useWorkspaceViewModel();
  const showConfirm = useShowModal('confirmActionModal');

  /**
   * 「重启本会话」按下确认之前攥着的那点东西 —— **两条腿都能重启**,所以认的是会话 id(宿主按它找记录)。
   * 宿主停完再起之后两条腿都原地接上:聊天面的副本跟着会话 id 走,终端认一个与进程无关的稳定 pty id。
   */
  const [pendingReload, setPendingReload] = useState<{ sessionId: string } | null>(null);
  const [reloading, setReloading] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ sessionId: string; view: SessionView } | null>(null);
  const [switching, setSwitching] = useState(false);

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

  /**
   * 换一种展示 = 三步,顺序不能反:主进程停掉旧那条腿并改记录 → 关掉旧种类的页签 → 在原来那一格开新种类的页签。
   * 先关后开:两种页签绑同一条会话,同时挂着的那一刻旧那条的资源还会去起它自己的运行时 —— 正是刚停掉的东西。
   * 失败就留在原地:记录没改、旧页签还在,用户看到一句原话而不是一个空的会话页。
   * 关旧开新是一笔、新那枚放回原位,见 replaceSessionTab。
   */
  const confirmSwitch = useCallback(async () => {
    const pending = pendingSwitch;
    if (!pending) return;
    setSwitching(true);
    try {
      const runtime = sessionRuntimeOfView(pending.view);
      await sessionRegistry.get(pageSessionId)?.switchSessionRuntime(pending.sessionId, runtime);
      replaceSessionTab(paneLayout, pending.sessionId, sessionTabKind(runtime));
    } catch (error) {
      showConfirm({
        title: translate(pending.view === 'general' ? 'task.switchToGeneralView' : 'task.switchToCodeView'),
        description: error instanceof Error ? error.message : String(error),
        confirmLabel: translate('common.close'),
        onSuccess: () => undefined,
      });
    } finally {
      setSwitching(false);
      setPendingSwitch(null);
    }
  }, [pendingSwitch, paneLayout, pageSessionId, showConfirm, translate]);

  /**
   * 一条会话每种展示选不选得了 —— 页签右键「切换为X模式」、模式按钮、聊天页递过来的请求读同一份判据:
   * 这一家给不给那条腿,与 composer 建会话共用一个判据(agentOffersSessionView);只经咕咕云连着的机器没有「编程」
   * (behavior gugu-server「别的机器上的『编程』只给用 SSH 装上的机器」)。原话与输入框那颗收起时的说法同一份。
   */
  const viewState = useCallback(
    (sessionId: string): SessionViewState | null => {
      const session = sessionRegistry.get(pageSessionId)?.sessions.get(sessionId);
      if (!session) return null;
      const agent = agents?.find((candidate) => candidate.id === session.data.providerId);
      const machine = machineRegistry.machineOf(projectId);
      return {
        view: sessionViewOfRuntime(session.data.runtime ?? 'pty'),
        lockOf(view) {
          const name = agent?.name ?? session.data.providerId;
          if (!agentOffersSessionView(agent?.capabilities, view)) {
            return translate(view === 'code' ? 'taskConfig.sessionViewGeneralOnly' : 'taskConfig.sessionViewCodeOnly', { name });
          }
          if (view === 'code' && machine !== null && remoteHostsStore.device(machine)?.directTerminal !== true) {
            return translate('taskConfig.sessionViewRemoteNeedsSsh');
          }
          return null;
        },
      };
    },
    [agents, pageSessionId, projectId, translate]
  );

  const requestView = useCallback(
    (sessionId: string, view: SessionView) => {
      const state = viewState(sessionId);
      if (!state || state.view === view) return;
      const lock = state.lockOf(view);
      if (lock) {
        showConfirm({
          title: translate(view === 'general' ? 'task.switchToGeneralView' : 'task.switchToCodeView'),
          description: lock,
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
        return;
      }
      setPendingSwitch({ sessionId, view });
    },
    [showConfirm, translate, viewState]
  );

  // 聊天页那颗模式按钮递过来的「换成X」(session-view-requests.ts):这一页上有那条会话就认领。
  // 名单(给不给那条腿)还没到时先不认领 —— 那时判据会把每种展示都判成「这家不给」。
  // 一次换展示还在问 / 正在换时也先不认领:认领了会把那一次的 pending 顶掉,它收尾时连带把这条清没。
  // 忙完 busy 翻回 false,effect 重挂、fireImmediately 再认领挂着的那条。
  const requestViewRef = useRef(requestView);
  requestViewRef.current = requestView;
  const agentsLoaded = agents !== undefined;
  const switchBusy = switching || pendingSwitch !== null;
  useEffect(() => {
    if (!agentsLoaded || switchBusy) return;
    return reaction(
      () => sessionViewRequests.pendingIds().filter((id) => sessionRegistry.get(pageSessionId)?.sessions.has(id)),
      (ids) => {
        for (const id of ids) {
          const view = sessionViewRequests.take(id);
          if (view) requestViewRef.current(id, view);
        }
      },
      { fireImmediately: true }
    );
  }, [agentsLoaded, pageSessionId, switchBusy]);

  const actions = useMemo<SessionActions>(
    () => ({
      viewState,
      requestView,
      commandsFor(sessionId, rename) {
        const session = sessionRegistry.get(pageSessionId)?.sessions.get(sessionId);
        if (!session) return [];
        const pinned = session.data.isPinned ?? false;
        const otherView: SessionView = sessionViewOfRuntime(session.data.runtime ?? 'pty') === 'general' ? 'code' : 'general';
        const canSwitch = viewState(sessionId)?.lockOf(otherView) === null;
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
          ...(canSwitch
            ? [
                {
                  id: 'session:switch-view',
                  label: translate(otherView === 'general' ? 'task.switchToGeneralView' : 'task.switchToCodeView'),
                  icon: otherView === 'code' ? Terminal : MessageSquare,
                  group: 'edit' as const,
                  isAvailable: () => !switching,
                  run: () => setPendingSwitch({ sessionId, view: otherView }),
                },
              ]
            : []),
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
    [paneLayout, pageSessionId, projectId, reloading, requestView, switching, translate, viewState]
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
      {/* 换一种展示重开 —— 与换模型 / MCP 开关 / 重启本会话共用同一个框、同一句代价。抬头就是菜单上那一项的名字。 */}
      <SessionReloadConfirm
        open={pendingSwitch !== null}
        onOpenChange={(next) => {
          if (!next && !switching) setPendingSwitch(null);
        }}
        reason="view-switch"
        target={translate(pendingSwitch?.view === 'general' ? 'task.switchToGeneralView' : 'task.switchToCodeView')}
        isReloading={switching}
        onConfirm={confirmSwitch}
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
