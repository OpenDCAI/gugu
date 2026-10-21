import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@renderer/features/tabs/pane-dimension-provider';
import { PaneSizingContextProvider } from '@renderer/lib/pty/pane-sizing-context';
import { PtyPane, type RemoteTerminalFiles } from '@renderer/lib/pty/pty-pane';
import { type PtySession } from '@renderer/lib/pty/pty-session';
import { useTerminalFindBackend } from '@renderer/lib/pty/use-terminal-search';
import { FindBar } from '@renderer/lib/ui/find-bar';
import { useFindBar } from '@renderer/lib/ui/use-find-bar';
import { cn } from '@renderer/utils/utils';

// Terminal tabs sit on the page background instead of the agent-terminal one.
const TERMINAL_TAB_THEME = { background: '--background' } as const;

export interface TerminalPtyContentProps {
  activeSession: PtySession | null;
  allPtySessionIds: string[];
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
  onEnterPress?: () => void;
  mapShiftEnterToCtrlJ?: boolean;
  emptyState: ReactNode;
  workspaceId: string;
  className?: string;
  /** 终端跑在别的机器上:本机路径在那边不存在,拖进 / 粘贴进来的文件先传过去,写那边的路径。 */
  remoteFiles?: RemoteTerminalFiles;
  /** 盖在终端上的那一层(别的机器:连接状态行 / ssh 提问卡片 / 传文件那一行)。 */
  overlay?: (session: PtySession, focusTerminal: () => void) => ReactNode;
  onExit?: () => void;
}

export const TerminalPtyContent = observer(function TerminalPtyContent({
  activeSession,
  allPtySessionIds,
  autoFocus,
  onFocusChange,
  onEnterPress,
  mapShiftEnterToCtrlJ,
  emptyState,
  workspaceId,
  className,
  remoteFiles,
  overlay,
  onExit,
}: TerminalPtyContentProps) {
  const activePtySessionId = activeSession?.ptySessionId ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<{ focus: () => void }>(null);
  const focusPendingRef = useRef(false);

  const findBackend = useTerminalFindBackend(activeSession?.pty?.terminal, Boolean(activeSession?.pty));
  const findBar = useFindBar({ rootRef: terminalContainerRef, backend: findBackend });

  // Fire when autoFocus becomes true or the active session changes.
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

  // Fire when the session transitions to 'ready'.
  const sessionStatus = activeSession?.status;
  useEffect(() => {
    if (sessionStatus === 'ready' && focusPendingRef.current) {
      focusPendingRef.current = false;
      terminalRef.current?.focus();
    }
  }, [sessionStatus]);

  const ptySessionIds = useMemo(() => allPtySessionIds, [allPtySessionIds]);
  const dimensionSink = useMemo(() => createPaneDimensionSink(), []);

  const hasSessions = ptySessionIds.length > 0;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={cn('flex h-full min-w-0 flex-col outline-none', className)}
      onFocus={() => onFocusChange?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          onFocusChange?.(false);
        }
      }}
    >
      <PaneDimensionProvider sink={dimensionSink}>
        <PaneSizingContextProvider ptySessionIds={ptySessionIds}>
          {!hasSessions || !activeSession ? (
            emptyState
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {activePtySessionId && activeSession?.status === 'ready' && activeSession.pty ? (
                <div
                  ref={terminalContainerRef}
                  className="relative flex h-full min-h-0 min-w-0 flex-1"
                >
                  <FindBar {...findBar} fullWidth />
                  <PtyPane
                    ref={terminalRef}
                    ptySessionId={activePtySessionId}
                    pty={activeSession.pty}
                    className="h-full w-full"
                    themeOverride={TERMINAL_TAB_THEME}
                    onEnterPress={onEnterPress}
                    mapShiftEnterToCtrlJ={mapShiftEnterToCtrlJ}
                    workspaceId={workspaceId}
                    localPaths={!remoteFiles}
                    remoteFiles={remoteFiles}
                    onExit={onExit}
                  />
                  {overlay?.(activeSession, () => terminalRef.current?.focus())}
                </div>
              ) : null}
            </div>
          )}
        </PaneSizingContextProvider>
      </PaneDimensionProvider>
    </div>
  );
});
