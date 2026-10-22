import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { PermissionBand } from '@gugu/session-ui/react/components';
import { useHostAskBand } from '@renderer/features/extensions/use-session-host-ask';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
// TODO(conversations-extraction): Pass task context actions into the panel as composition.
import { ContextBar } from '@renderer/features/sessions/context-bar/context-bar';
// TODO(conversations-extraction): Pass task scope into conversations instead of importing task hooks.
import { useIsActiveSession } from '@renderer/features/sessions/hooks/use-is-active-session';
import { useMarkSeenWhenShown } from '@renderer/features/sessions/hooks/use-mark-seen-when-shown';
import {
  useSessions,
  useSessionViewContext,
  useWorkspaceId,
  useWorkspaceViewModel,
} from '@renderer/features/sessions/session-view-context';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { PaneSizingContextProvider } from '@renderer/lib/pty/pane-sizing-context';
import { PtyPane } from '@renderer/lib/pty/pty-pane';
import { useTerminalFindBackend } from '@renderer/lib/pty/use-terminal-search';
import { FindBar } from '@renderer/lib/ui/find-bar';
import { useFindBar } from '@renderer/lib/ui/use-find-bar';
import type { SessionTabResource } from './session-tab-resource';
import {
  activeSessionResource,
  activeSessionId as activeSessionId,
} from './pane-selectors';
import { ProviderSessionMissingView } from './provider-session-missing-view';
import { SessionStartFailedView } from './session-start-failed-view';
import { rpc } from '@renderer/lib/ipc';
import { sessionStartStage } from './stores/session-start-stages';
import { sessionStartupFailures } from './stores/session-startup-failures';
import { requestTerminalModelMenu } from './view/terminal-model-menu-request';
import { useSessionStartupFailure } from './use-session-startup-failure';
import { useSessionSchedules } from '@renderer/features/automations/use-session-schedules';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { SessionScheduleChip } from './session-schedule-chip';
import { SessionPermissionHint } from './session-permission-hint';

export const SessionsPanel = observer(function SessionsPanel() {
  const { translate } = useSessionMessages();
  const { sessionId } = useSessionViewContext();
  const sessionView = useWorkspaceViewModel();
  const sessions = useSessions();
  const workspaceId = useWorkspaceId();
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const { pane } = usePaneContext();
  const isActive = useIsActiveSession(sessionId);

  const autoFocus =
    isActive && sessionView.focusedRegion === 'main' && sessionNavigationFocus.focusLayer !== 'nav';

  // Build session ID list for PaneSizingContextProvider (all open conversation tabs).
  const allPtySessionIds = pane.resolvedTabs
      .filter(
        (t): t is typeof t & { resource: SessionTabResource } => t.kind === 'session'
      )
      .map((t) => sessions.ptySessions.get(t.resource.sessionId)?.ptySessionId)
      .filter((id): id is string => Boolean(id));

  const activeResource = activeSessionResource(pane);
  const activeSession = activeResource?.store ?? null;
  const registryFailure = activeResource?.loadFailure;
  const activeSessionStoreId = activeSession?.data.id ?? null;
  const activePtySession = activeSession
    ? (sessions.ptySessions.get(activeSession.data.id) ?? null)
    : null;
  const activePtySessionId = activePtySession?.ptySessionId ?? null;
  // 这条会话的启动是不是已经确定失败了 —— 加载态靠它才有出口，见 use-session-startup-failure。
  const startupFailure = useSessionStartupFailure(activeSessionStoreId);
  const startupFailureView = startupFailure ? (
    <SessionStartFailedView
      failure={startupFailure}
      onRetry={() => sessionStartupFailures.retry(startupFailure.sessionId)}
      providerId={activeSession?.data.providerId ?? null}
      onSwitchModel={() => requestTerminalModelMenu(startupFailure.sessionId)}
    />
  ) : null;
  // #6183 启动不设墙钟 ⇒ 这一步要看得见、能取消。取消走既有的停止会话,失败原文照旧进启动失败账本。
  const startStage = sessionStartStage(activeSessionStoreId);
  // D-31 The host's ask for this agent (an App install): the band a chat-UI session shows on its composer, here under the
  // terminal — the harness's own approvals are asked in its TUI, this one is the session timeline's (125 10-06). Read only
  // while the session waits on an approval.
  const hostBand = useHostAskBand(activeSessionStoreId, activeSession);
  const scheduleMachine = activeSession ? machineRegistry.machineOf(activeSession.data.projectId) : null;
  const schedules = useSessionSchedules(scheduleMachine, activeSessionStoreId ?? '', activeSession !== null);
  // 终端腿只有版本探针这一步由宿主报;`preparing-adapter` 属于聊天腿,这里不认。
  const startStageLabel = startStage?.stage === 'checking-executable'
    ? translate('chat.startingSessionChecking', {
        engine: startStage.executable.split(/[\\/]/).pop() || startStage.executable,
        since: new Date(startStage.since).toLocaleTimeString(),
      })
    : null;

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ focus: () => void }>(null);
  const focusPendingRef = useRef(false);

  const findBackend = useTerminalFindBackend(activePtySession?.pty?.terminal, Boolean(activePtySession?.pty));
  const findBar = useFindBar({ rootRef: terminalContainerRef, backend: findBackend });

  useEffect(() => {
    if (!autoFocus) return;
    if (terminalRef.current) {
      terminalRef.current.focus();
      focusPendingRef.current = false;
    } else {
      containerRef.current?.focus();
      focusPendingRef.current = true;
    }
  }, [autoFocus, activePtySessionId]);

  const sessionStatus = activePtySession?.status;
  useEffect(() => {
    if (sessionStatus === 'ready' && focusPendingRef.current) {
      focusPendingRef.current = false;
      terminalRef.current?.focus();
    }
  }, [sessionStatus]);

  // State-driven notification clearing: mark the active conversation as seen
  // whenever this task view is the active route and the conversation has an
  // unseen status. This covers the split-pane case where the same tab stays
  // active — the engine's onActivate() only fires on tab identity changes.
  useMarkSeenWhenShown(activeSession, isActive);

  const hideContextBarTrigger = interfaceSettings?.hideContextBar ?? false;

  // Measure the rendered height of the ContextBar so the PTY controller can
  // subtract it from the available terminal height. The ContextBar renders null
  // (height 0) when not visible and a fixed single-row bar otherwise, so the
  // measured value is always accurate without needing to know its CSS internals.
  const contextBarWrapperRef = useRef<HTMLDivElement>(null);
  const [contextBarHeight, setContextBarHeight] = useState(0);
  useEffect(() => {
    const el = contextBarWrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContextBarHeight(entry.contentRect.height);
    });
    observer.observe(el);
    // Initial measurement.
    setContextBarHeight(el.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);

  return (
    // 这个表面和 ACP 那个表面做的是同一件事：把 pane 当前 active 的会话渲染出来。
    // ACP 那边在自己的根节点上说得出「我现在绑的是谁」（`acp-chat-panel.tsx` 的
    // `data-session-chat-surface` / `data-session-chat-session-id`），终端这边一直说不出 ——
    // `sessionId` 只作为 prop 传进 `PtyPane`，外面看到的只有一个 `data-region`。
    // 一个表面既然要「绑定」，就该说得出自己绑的是谁；这里把缺的那一格补齐，与 ACP 侧同名同族。
    <div
      className="flex h-full flex-col"
      data-session-chat-surface="terminal"
      data-session-chat-session-id={activeSessionStoreId ?? undefined}
    >
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          tabIndex={-1}
          className="flex h-full min-w-0 flex-1 flex-col outline-none"
          onFocus={() => {
            if (isActive) sessionView.setFocusedRegion('main');
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              // focus left the panel — no region change needed
            }
          }}
        >
          {/* ⚠️ 「引擎那侧的会话没了」**不再整块替换终端**（spec `session-always-openable`）。
              终端这条腿的内容活在 tmux 里（history-limit，见 tmux-session-name.ts），会话跑完
              它还在 —— 一整块替换掉，用户就再也看不到自己跑过什么。
              判据与聊天那条腿一致：**有东西可看就不许盖**。所以只有当这条会话确实没有
              终端可画时，恢复界面才成为这一块的内容；有终端就照常画终端，恢复入口挪到
              下面 ContextBar 那一行旁边。 */}
          {activeSession?.data.providerSessionState === 'missing'
          && !(activePtySession?.status === 'ready' && activePtySession.pty && activePtySession.hasOutput) ? (
            <ProviderSessionMissingView
              sessionId={activeSession.data.id}
            />
          ) : (
            <PaneSizingContextProvider ptySessionIds={allPtySessionIds} bottomPadding={contextBarHeight}>
              <div className="flex min-h-0 flex-1 flex-col">
                {activeSessionStoreId
                  && activePtySessionId
                  && activePtySession?.status === 'ready'
                  && activePtySession.pty
                  // ⚠️ `ready` 只代表管道通了，不代表有东西可看。agent 起来之前终端是一片空白 +
                  // 左上角一个闪烁光标 —— owner 实测把这一段读成「还有个老的加载态在」。
                  // 等待的后半段不该是裸的，所以撤加载态要看「真的有内容了」。
                  // ❌ 别改成墙钟超时兜底：一个永远不输出任何东西的会话就是卡住了，
                  // 这时继续说「正在启动会话...」是实话，不是兜底。
                  && activePtySession.hasOutput ? (
                  <div className="flex h-full min-h-0 flex-1 flex-col">
                    <div
                      ref={terminalContainerRef}
                      data-region="session-terminal"
                      className="relative flex min-h-0 flex-1"
                    >
                      <FindBar {...findBar} fullWidth />
                      <PtyPane
                        ref={terminalRef}
                        ptySessionId={activePtySessionId}
                        pty={activePtySession.pty}
                        className="h-full w-full"
                        mapShiftEnterToCtrlJ
                        workspaceId={workspaceId}
                      />
                    </div>
                  </div>
                ) : activeSessionStoreId ? (
                  // 终端还没 ready 的等待期。这里以前是 `null` —— 一整块空白，
                  // 用户看不出是在等还是坏了。
                  //
                  // ⚠️ 别在这里排除 `disconnected`：那不是「已断开的死会话」，而是**还没开始连**。
                  // PtySession 的初始状态就是 disconnected，`onBecomeObserved(status)` 要等这个面板
                  // 读到 status 那一刻才触发懒连接 —— 也就是说等待期的第一段恰恰是 disconnected。
                  // 排除它 = 在用户真正在等的那一段渲染空白（owner 实测「启动 TUI 没看到加载页」即此）。
                  // 会话被 dispose(关页签时 dehydrate)后也是 disconnected。那时别的视图可能一直读着 status,
                  // 懒连接不会再触发；把它接回来的是重开时 hydrate 落定后的那次 connect(page-sessions-store)。
                  //
                  // ⚠️ 等待期必须有出口：撤加载态的条件是「画面上真的有东西了」，
                  // 而一个起不来的会话永远满足不了它 —— 没有下面这一支，圈就会一直转下去
                  // （owner 实测 codex：`did not receive an injected first turn within 90000ms`，
                  // 转满 90 秒仍在转）。出口不是墙钟超时（起得慢 ≠ 坏了，实测 OpenCode 要 9.1s），
                  // 而是账本里那条由 hydrate 真的抛错才写下的确定性失败。
                  startupFailure ? (
                    startupFailureView
                  ) : (
                    <div
                      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2"
                      data-start-stage={startStage?.stage}
                      title={startStage?.executable}
                    >
                      {startStage ? (
                        <>
                          <LoadingIndicator
                            ariaLabel={startStageLabel ?? ''}
                            label={startStageLabel ?? ''}
                            data-testid="session-terminal-loading"
                          />
                          {activePtySessionId ? (
                            <button
                              type="button"
                              data-testid="session-start-cancel"
                              className="text-xs text-foreground-muted underline-offset-2 hover:underline"
                              onClick={() => void rpc.pty.stopSession(activePtySessionId)}
                            >
                              {translate('transcript.condition.cancel')}
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <LoadingIndicator
                          ariaLabel={translate('chat.startingSession')}
                          label={translate('chat.startingSession')}
                          data-testid="session-terminal-loading"
                        />
                      )}
                      {activeSession && <SessionPermissionHint projectId={activeSession.data.projectId} />}
                    </div>
                  )
                ) : registryFailure ? (
                  <SessionStartFailedView
                    failure={registryFailure}
                    onRetry={() => activeResource?.retryLoad()}
                  />
                ) : (
                  // ⚠️ 这里此前是 `null` —— 一整块纯白，没有任何文案，用户不知道是在等还是坏了
                  //    （spec `session-always-openable`：「打不开」不是一种可接受的降级形态）。
                  //    到这里说明这条 pane 还没认到会话 store，那是过渡态，所以说的是「正在打开」。
                  <div className="flex h-full min-h-0 flex-1 items-center justify-center">
                    <LoadingIndicator
                      ariaLabel={translate('chat.startingSession')}
                      label={translate('chat.startingSession')}
                      data-testid="session-terminal-opening"
                    />
                  </div>
                )}
              </div>
            </PaneSizingContextProvider>
          )}
        </div>
      </div>
      {/* ⚠️ ContextBar 此前在 missing 态被整条摘掉。既然终端不再被替换，它也要留着 ——
          否则会话照常画出来了，却连切模型 / 改权限 / 重来的入口都没有。 */}
      {/* The band sits in the measured wrapper: the terminal gives up its rows while the ask is out. */}
      {(
        <div ref={contextBarWrapperRef}>
          {activePtySession?.status === 'ready' && activePtySession.pty && activePtySession.hasOutput
            ? startupFailureView
            : null}
          {hostBand ? (
            <div className="px-2 pt-1" data-testid="session-terminal-host-ask">
              <PermissionBand request={hostBand.request} onResolve={hostBand.resolve} />
            </div>
          ) : null}
          <ContextBar
            sessionId={activeSessionId(pane)}
            hideTrigger={hideContextBarTrigger}
            leading={
              schedules.length > 0 ? <SessionScheduleChip machine={scheduleMachine} schedules={schedules} /> : null
            }
          />
        </div>
      )}
    </div>
  );
});
