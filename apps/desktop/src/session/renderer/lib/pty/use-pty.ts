import { platform } from '@/platform';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { i18n } from '@/i18n';
import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import { type Terminal } from '@xterm/xterm';
import { isMacHost, isWindowsHost } from '@shared/host-os';
import { reaction } from 'mobx';
import { useCallback, useContext, useEffect, useRef } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { dispatchMatchingHotkeys } from '@renderer/lib/hotkeys/dispatch-matching-hotkeys';
import { events, rpc } from '@renderer/lib/ipc';
import { observePtyOutput } from '../session-output-observers';
import { log } from '@renderer/utils/logger';
import type { AppSettings } from '@shared/core/app-settings';
import { ptyExitChannel } from '@shared/core/pty/ptyEvents';
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings';
import { appPasteChannel, terminalContextMenuActionChannel } from '@shared/events/appEvents';
import { terminalIsBehindModal } from './terminal-behind-modal';
import { usePaneSizingContext } from './pane-sizing-context';
import type { FrontendPty, SessionTheme } from './pty';
import { isRealTaskInput, SubmittedInputBuffer } from './pty-input-buffer';
import {
  CTRL_J_ASCII,
  CTRL_U_ASCII,
  shouldCopySelectionFromTerminal,
  shouldDispatchAppHotkeyFromTerminal,
  shouldKillLineFromTerminal,
  shouldMapShiftEnterToCtrlJ,
  shouldPasteToTerminal,
} from './pty-keybindings';
import { sendTerminalInput } from './send-terminal-input';
import { getTerminalContextLink } from './terminal-context-link';
import { handleTerminalKeyboardExit } from './terminal-keyboard-exit';
import { buildTerminalFontFamily, flushTerminalWidthCache } from './terminal-font';
import { getCellMetrics } from './xterm-cell-metrics';

const IS_MAC_PLATFORM = isMacHost();
const IS_WINDOWS_PLATFORM = isWindowsHost();
const LAST_SELECTION_COPY_GRACE_MS = 2_000;

function dispatchTerminalAppHotkey(event: KeyboardEvent): boolean {
  if (!shouldDispatchAppHotkeyFromTerminal(event, IS_MAC_PLATFORM)) return false;
  return dispatchMatchingHotkeys(event, { dispatch: 'first' });
}

function getRecentSelection(selection: { text: string; capturedAt: number } | null): string {
  if (!selection) return '';
  if (Date.now() - selection.capturedAt > LAST_SELECTION_COPY_GRACE_MS) return '';
  return selection.text;
}

function createContextMenuRequestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

export interface UsePtyOptions {
  /** Deterministic PTY session ID: makePtySessionId(projectId, scopeId, leafId). */
  ptySessionId: string;
  /** Pre-connected FrontendPty instance owned by the entity's PtySession store. */
  pty: FrontendPty;
  theme?: SessionTheme;
  mapShiftEnterToCtrlJ?: boolean;
  onActivity?: () => void;
  onExit?: (info: { exitCode: number | undefined; signal?: number }) => void;
  onEnterPress?: (message: string) => void;
  onPasteFromClipboard?: PasteFromClipboardHandler;
}

export interface UseTerminalReturn {
  focus: () => void;
  sendInput: (data: string, options?: { track?: boolean }) => void;
}

export type PasteFromClipboardHandler = (helpers: {
  focus: UseTerminalReturn['focus'];
  sendInput: UseTerminalReturn['sendInput'];
}) => void;

/**
 * React hook that manages a full xterm.js terminal instance attached to
 * `containerRef`, wired to a PTY session via the deterministic `sessionId`.
 *
 * Each session owns a persistent FrontendPty (terminal + Canvas2D renderer)
 * for its full lifetime.  On unmount the terminal's ownedContainer is
 * reparented to the off-screen xterm host rather than disposed, so scrollback
 * is preserved across tab switches.
 *
 * For sessions pre-registered via PtySessionProvider the mount is effectively
 * synchronous (no await needed).  Standalone sessions (not pre-registered)
 * are auto-registered inside an async IIFE, awaiting the historical buffer
 * fetch before mounting.
 *
 * When inside a PaneSizingContextProvider the terminal is pre-resized to the pane's
 * current dimensions BEFORE being appended to the visible DOM, eliminating
 * the flash caused by a post-mount resize.
 */
export function usePty(
  options: UsePtyOptions,
  containerRef: React.RefObject<HTMLElement | null>
): UseTerminalReturn {
  const {
    ptySessionId,
    pty,
    theme,
    mapShiftEnterToCtrlJ,
    onActivity,
    onExit,
    onEnterPress,
    onPasteFromClipboard,
  } = options;

  // Stable refs for callbacks so the effect doesn't re-run on every render.
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onEnterPressRef = useRef(onEnterPress);
  onEnterPressRef.current = onEnterPress;
  const onPasteFromClipboardRef = useRef(onPasteFromClipboard);
  onPasteFromClipboardRef.current = onPasteFromClipboard;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // The per-pane controller owns PTY backend resizes (broadcast to ALL sessions)
  // and exposes an observable controllerDims box so this terminal can call
  // term.resize() reactively. PtyPane guarantees a context is always present by
  // self-provisioning a PaneDimensionProvider + PaneSizingContextProvider when
  // no ancestor provides one.
  const paneSizing = usePaneSizingContext();
  // Ref so the main effect (which only re-runs on sessionId change) always
  // accesses the latest context value without needing it as a dependency.
  const paneSizingRef = useRef(paneSizing);
  paneSizingRef.current = paneSizing;

  // Core xterm.js reference, kept alive across renders.
  const termRef = useRef<Terminal | null>(null);

  // Tracks submitted user input while filtering terminal control traffic.
  const submittedInputBufferRef = useRef(new SubmittedInputBuffer());

  // Track whether the PTY has started (to filter focus reporting escape sequences).
  const ptyStartedRef = useRef(false);

  // Auto-copy on selection
  const autoCopyOnSelectionRef = useRef(false);
  const lastSelectionRef = useRef<{ text: string; capturedAt: number } | null>(null);
  const contextMenuRequestIdRef = useRef<string | null>(null);

  // 任务帧从隐藏测量槽移动到可见槽时，布局可能跨越多次绘制才稳定；延迟校准必须可取消，
  // 避免已卸载的终端异步调整新终端的尺寸。
  const layoutMeasureFrameRef = useRef<number | null>(null);
  const layoutMeasureGenerationRef = useRef(0);
  const measureRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  // Calibrates the per-pane controller with the mounted terminal's real cell
  // metrics. The controller recomputes cols/rows, updates controllerDims, and
  // broadcasts rpc.pty.resize to ALL sessions. The MobX reaction below then
  // applies term.resize() to the visible grid.
  //
  // Cold-path retry: the terminal is opened off-DOM so xterm's font measurement
  // may not be populated yet on the first call — retries up to 5 times.
  //
  // Runs synchronously so the xterm DOM catches up in the same paint as the
  // new container size (ENG-1577).
  const measureAndResize = useCallback(
    (retries = 0) => {
      try {
        const term = termRef.current;
        if (!term) return;
        const pane = paneSizingRef.current;
        if (!pane) {
          log.warn('useTerminal: no PaneSizingContext — cannot calibrate', { ptySessionId });
          return;
        }

        const cell = getCellMetrics(term);
        if (!cell) {
          // Cold-path: terminal was opened off-DOM so xterm's font measurement
          // hasn't populated yet.  Retry up to 5 times to avoid an infinite loop.
          if (retries < 5) {
            if (measureRetryTimerRef.current !== null) {
              clearTimeout(measureRetryTimerRef.current);
            }
            measureRetryTimerRef.current = setTimeout(() => {
              measureRetryTimerRef.current = null;
              measureAndResizeRef.current(retries + 1);
            }, 100);
          }
          return;
        }

        // Calibrate the controller with exact cell metrics.
        // The controller recomputes cols/rows, updates controllerDims, and
        // broadcasts rpc.pty.resize to all sessions. The MobX reaction below
        // applies term.resize() when controllerDims changes.
        pane.calibrateCell(cell.width, cell.height);
      } catch (e) {
        log.warn('useTerminal: measureAndResize failed', { ptySessionId, error: e });
      }
    },
    [ptySessionId]
  );

  // Stable ref so the retry setTimeout inside measureAndResize always calls
  // the latest version without creating a circular useCallback dependency.
  const measureAndResizeRef = useRef(measureAndResize);
  measureAndResizeRef.current = measureAndResize;

  const cancelScheduledLayoutMeasure = useCallback(() => {
    layoutMeasureGenerationRef.current += 1;
    if (layoutMeasureFrameRef.current !== null) {
      cancelAnimationFrame(layoutMeasureFrameRef.current);
      layoutMeasureFrameRef.current = null;
    }
  }, []);

  const scheduleLayoutMeasure = useCallback(() => {
    cancelScheduledLayoutMeasure();
    const generation = layoutMeasureGenerationRef.current;
    let framesRemaining = 2;

    const measureAfterFrame = () => {
      if (generation !== layoutMeasureGenerationRef.current) return;
      framesRemaining -= 1;
      if (framesRemaining > 0) {
        layoutMeasureFrameRef.current = requestAnimationFrame(measureAfterFrame);
        return;
      }
      layoutMeasureFrameRef.current = null;
      measureAndResizeRef.current();
    };

    if (typeof requestAnimationFrame === 'function') {
      layoutMeasureFrameRef.current = requestAnimationFrame(measureAfterFrame);
    } else {
      // 这个 hook 只在浏览器中挂载；保留 fallback 让 renderer 测试使用精简 DOM shim 时也安全。
      measureAndResizeRef.current();
    }
  }, [cancelScheduledLayoutMeasure]);

  const focus = useCallback(() => {
    // Don't steal focus from an open modal — unless this terminal is rendered
    // inside it (e.g. the agent sign-in terminal).
    const dialog = document.activeElement?.closest('[role="dialog"]');
    if (dialog && !dialog.contains(containerRef.current)) return;
    termRef.current?.focus();
  }, [containerRef]);

  const copySelectionToClipboard = useCallback(() => {
    const selection =
      termRef.current?.getSelection() || getRecentSelection(lastSelectionRef.current);
    if (selection) {
      void platform.writeClipboardText(selection).catch((error) => { log.error({ error: error }, 'action failed'); toast({ title: translateSessionMessage('task.copyFailed'), description: messageForUser(error), tier: 'error' }); });
    }
  }, []);

  const sendInput = useCallback(
    (data: string, options?: { track?: boolean }) => {
      const shouldTrack = options?.track ?? true;
      if (shouldTrack) {
        const submittedMessages = submittedInputBufferRef.current.feed(data);
        for (const message of submittedMessages) {
          if (isRealTaskInput(message)) {
            onEnterPressRef.current?.(message);
          }
        }
      }
      sendTerminalInput(ptySessionId, data);
    },
    [ptySessionId]
  );

  const pasteFromClipboard = useCallback(() => {
    const customPasteFromClipboard = onPasteFromClipboardRef.current;
    if (customPasteFromClipboard) {
      customPasteFromClipboard({ focus, sendInput });
      return;
    }

    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) sendInput(text);
      } catch (error) {
        log.error({ error }, 'terminal paste failed'); toast({ title: i18n.t('shell.titlebar.items.paste', { ns: 'main' }), description: messageForUser(error), tier: 'error' });
      }
    })();
  }, [focus, sendInput]);

  const pageShown = useContext(PageShownContext);

  // ─── Main effect: mount terminal once per sessionId ────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Mount ─────────────────────────────────────────────────────────────────
    // pty is pre-connected by PtySession before TerminalPane renders, so no
    // async work is needed here.
    const cleanups: (() => void)[] = [];
    let disposed = false;

    {
      const frontendPty = pty;
      termRef.current = frontendPty.terminal;
      lastSelectionRef.current = null;

      // Apply current theme before mounting (in case it differs from the
      // theme the terminal was constructed with).
      frontendPty.setTheme(themeRef.current);

      // @@@own-grid-on-mount — the terminal mounts at the grid it already has: the one its own layout
      // gave it last time (or the PTY's, on first connect). A pane can come to show another session
      // (a fresh page, a terminal tab switching), and whatever it remembers at this moment (controller
      // dims, the pane's current pixels) may still describe the layout before — new geometry lands later.
      // Sizing the terminal from it reflowed it, and resized its PTY, to the previous session's width
      // and back. The only sync is the one after layout has settled: two frames on, the pane is
      // measured as it is now and the PTY gets that grid only if it differs from what it has.
      frontendPty.mount(container as HTMLElement);
      scheduleLayoutMeasure();

      cleanups.push(() => {
        cancelScheduledLayoutMeasure();
        if (measureRetryTimerRef.current !== null) {
          clearTimeout(measureRetryTimerRef.current);
          measureRetryTimerRef.current = null;
        }
      });

      // ── Load settings ──────────────────────────────────────────────────────
      let customFontFamily = '';
      void (rpc.appSettings.get('terminal') as Promise<AppSettings['terminal']>).then(
        (terminalSettings) => {
          if (disposed) return;
          if (terminalSettings?.fontFamily) {
            customFontFamily = terminalSettings.fontFamily.trim();
            if (customFontFamily) {
              frontendPty.terminal.options.fontFamily = buildTerminalFontFamily(customFontFamily);
            }
          }
          frontendPty.terminal.options.fontSize =
            terminalSettings?.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT;
          measureAndResize();
          scheduleLayoutMeasure();
          autoCopyOnSelectionRef.current = terminalSettings?.autoCopyOnSelection ?? false;
          frontendPty.terminal.options.macOptionIsMeta = terminalSettings?.macOptionIsMeta ?? false;
        }
      );

      // ── DECRQM xterm.js 6.0 bug workaround ────────────────────────────────
      const terminal = frontendPty.terminal;
      try {
        const parser = (
          terminal as unknown as {
            parser?: { registerCsiHandler?: (...args: unknown[]) => { dispose(): void } };
          }
        ).parser;
        if (parser?.registerCsiHandler) {
          const ansiDisp = parser.registerCsiHandler(
            { intermediates: '$', final: 'p' },
            (params: (number | number[])[]) => {
              const mode = (params[0] as number) ?? 0;
              sendInput(`\x1b[${mode};0$y`, { track: false });
              return true;
            }
          );
          const decDisp = parser.registerCsiHandler(
            { prefix: '?', intermediates: '$', final: 'p' },
            (params: (number | number[])[]) => {
              const mode = (params[0] as number) ?? 0;
              sendInput(`\x1b[?${mode};0$y`, { track: false });
              return true;
            }
          );
          cleanups.push(
            () => ansiDisp.dispose(),
            () => decDisp.dispose()
          );
        }
      } catch (err) {
        log.warn('useTerminal: failed to register DECRQM workaround', { error: err });
      }

      // ── Keyboard shortcuts ─────────────────────────────────────────────────
      terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Ignore keys only while a *modal* covers this terminal. The agent sign-in terminal
        // lives inside its modal and keeps its keys; non-modal popovers (hover cards) never block.
        if (terminalIsBehindModal(container)) return false;

        // The way out to the session list. Checked before the app-hotkey dispatch below because
        // that one is platform-gated (every key on macOS, tab navigation only elsewhere) and this
        // chord has to behave the same on all three. Consuming it here also means xterm never
        // encodes it, so the PTY sees no stray escape sequence.
        if (handleTerminalKeyboardExit(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          return false;
        }

        // xterm handles key events before TanStack's document-level hotkey listeners.
        // Preserve terminal Ctrl sequences on non-macOS except for tab navigation.
        if (dispatchTerminalAppHotkey(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          return false;
        }

        if (
          shouldCopySelectionFromTerminal(
            event,
            IS_MAC_PLATFORM,
            terminal.hasSelection(),
            getRecentSelection(lastSelectionRef.current) !== ''
          )
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          copySelectionToClipboard();
          return false;
        }

        if (shouldPasteToTerminal(event, IS_MAC_PLATFORM, IS_WINDOWS_PLATFORM)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          pasteFromClipboard();
          return false;
        }

        if (mapShiftEnterToCtrlJ && shouldMapShiftEnterToCtrlJ(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          sendInput(CTRL_J_ASCII);
          return false;
        }

        if (shouldKillLineFromTerminal(event, IS_MAC_PLATFORM)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
          sendInput(CTRL_U_ASCII);
          return false;
        }

        if (
          IS_MAC_PLATFORM &&
          event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            sendInput('\x01');
            return false;
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopImmediatePropagation();
            event.stopPropagation();
            sendInput('\x05');
            return false;
          }
        }

        return true;
      });

      // ── Handle terminal input ──────────────────────────────────────────────
      const handleTerminalInput = (data: string) => {
        onActivityRef.current?.();

        let filtered = data;
        if (!ptyStartedRef.current) {
          filtered = data.replace(/\x1b\[I|\x1b\[O/g, '');
        }
        if (!filtered) return;

        sendInput(filtered);
      };

      const detachInputHandler = frontendPty.attachInputHandler(handleTerminalInput);
      cleanups.push(detachInputHandler);

      // Observe FrontendPty's existing output stream. A second IPC listener
      // would keep the remote terminal subscribed after the view is hidden.
      cleanups.push(observePtyOutput((id) => {
        if (id === ptySessionId) ptyStartedRef.current = true;
      }));

      // ── Auto-copy on selection ─────────────────────────────────────────────
      let selectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      const selectionDisposable = terminal.onSelectionChange(() => {
        const selection = terminal.getSelection();
        if (selection) {
          lastSelectionRef.current = { text: selection, capturedAt: Date.now() };
        }

        if (!autoCopyOnSelectionRef.current) return;
        if (!terminal.hasSelection()) return;
        if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
        selectionDebounceTimer = setTimeout(() => {
          if (terminal.hasSelection()) {
            copySelectionToClipboard();
          }
        }, 150);
      });
      cleanups.push(() => {
        selectionDisposable.dispose();
        if (selectionDebounceTimer) clearTimeout(selectionDebounceTimer);
      });

      // ── Native context menu ────────────────────────────────────────────────
      const handleContextMenuMouseDown = (event: MouseEvent) => {
        if (event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
      };
      const handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        const requestId = createContextMenuRequestId();
        contextMenuRequestIdRef.current = requestId;
        const selectionText =
          terminal.getSelection() || getRecentSelection(lastSelectionRef.current);
        const linkText = getTerminalContextLink(terminal, event);
        void rpc.app.showTerminalContextMenu({
          requestId,
          selectionText,
          linkText,
          x: event.clientX,
          y: event.clientY,
        });
      };
      const offTerminalContextMenuAction = events.on(
        terminalContextMenuActionChannel,
        (payload) => {
          if (payload.requestId !== contextMenuRequestIdRef.current) return;
          contextMenuRequestIdRef.current = null;

          if (payload.action === 'paste') {
            pasteFromClipboard();
            return;
          }
          if (payload.action === 'select-all') {
            terminal.selectAll();
            return;
          }
          if (payload.action === 'clear') {
            frontendPty.clear();
          }
        }
      );
      frontendPty.ownedContainer.addEventListener('mousedown', handleContextMenuMouseDown, true);
      frontendPty.ownedContainer.addEventListener('contextmenu', handleContextMenu);
      cleanups.push(() => {
        offTerminalContextMenuAction();
        contextMenuRequestIdRef.current = null;
        frontendPty.ownedContainer.removeEventListener(
          'mousedown',
          handleContextMenuMouseDown,
          true
        );
        frontendPty.ownedContainer.removeEventListener('contextmenu', handleContextMenu);
      });

      // ── Paste from app menu ────────────────────────────────────────────────
      const offPaste = events.on(appPasteChannel, () => {
        pasteFromClipboard();
      });
      cleanups.push(offPaste);

      // ── PTY exit subscription ──────────────────────────────────────────────
      const offExit = events.on(
        ptyExitChannel,
        (info) => {
          onExitRef.current?.(info as { exitCode: number | undefined; signal?: number });
        },
        ptySessionId
      );
      cleanups.push(offExit);

      // ── Font / setting change events ───────────────────────────────────────
      const handleFontChange = (e: Event) => {
        const detail = (e as CustomEvent<{ fontFamily?: string; fontSize?: number }>).detail;
        if (detail?.fontFamily !== undefined) {
          customFontFamily = detail.fontFamily.trim();
          terminal.options.fontFamily = buildTerminalFontFamily(customFontFamily);
        } else if (detail?.fontSize === undefined) {
          // 字体族与字号都没变 —— 这是 watchTerminalFontReady 在说「随包的字体下载完了」。
          // 光重量格子不够:xterm 那份按回退字体量出来的字宽缓存还在,必须扔掉重量,
          // 否则每个汉字会一直带着那条按旧字宽算出来的 letter-spacing。
          flushTerminalWidthCache(terminal);
        }
        if (detail?.fontSize !== undefined) {
          terminal.options.fontSize = detail.fontSize;
        }
        measureAndResize();
        scheduleLayoutMeasure();
      };
      const handleAutoCopyChange = (e: Event) => {
        const detail = (e as CustomEvent<{ autoCopyOnSelection?: boolean }>).detail;
        autoCopyOnSelectionRef.current = detail?.autoCopyOnSelection ?? false;
      };
      const handleMacOptionIsMetaChange = (e: Event) => {
        const detail = (e as CustomEvent<{ macOptionIsMeta?: boolean }>).detail;
        terminal.options.macOptionIsMeta = detail?.macOptionIsMeta ?? false;
      };
      window.addEventListener('terminal-font-changed', handleFontChange);
      window.addEventListener('terminal-auto-copy-changed', handleAutoCopyChange);
      window.addEventListener('terminal-mac-option-is-meta-changed', handleMacOptionIsMetaChange);
      cleanups.push(
        () => window.removeEventListener('terminal-font-changed', handleFontChange),
        () => window.removeEventListener('terminal-auto-copy-changed', handleAutoCopyChange),
        () =>
          window.removeEventListener(
            'terminal-mac-option-is-meta-changed',
            handleMacOptionIsMetaChange
          )
      );

      // ── Resize trigger ────────────────────────────────────────────────────
      // React to controllerDims — the observable box updated by the per-pane
      // resize controller when pane pixel dimensions or cell size changes.
      // The controller owns PTY backend broadcasts; here we only apply
      // term.resize() to keep the visible xterm grid in sync. The reaction
      // fires synchronously within the ResizeObserver → MobX action → reaction
      // chain, preserving the "resize before next paint" guarantee (ENG-1577).
      const paneAtMount = paneSizingRef.current;
      if (paneAtMount) {
        const disposeReaction = reaction(
          () => paneAtMount.controllerDims.get(),
          (dims) => {
            if (!dims) return;
            const term = termRef.current;
            if (!term) return;
            if (term.cols !== dims.cols || term.rows !== dims.rows) {
              term.resize(dims.cols, dims.rows);
            }
            // 面板几何尺寸稳定后重新校准；这也覆盖任务帧从隐藏变为可见、初次挂载没有有效尺寸的情况。
            scheduleLayoutMeasure();
          }
        );
        cleanups.push(disposeReaction);
      }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      disposed = true;
      // controllerDims reaction and other cleanups run BEFORE unmount —
      // preserving the invariant that they are torn down before the
      // ownedContainer is reparented off-screen.
      for (const fn of cleanups) {
        try {
          fn();
        } catch {}
      }
      // Return terminal's ownedContainer to the off-screen host only if this
      // React host still owns it. A terminal session can be reparented into a
      // different surface before this cleanup runs; in that case, unmounting
      // here would steal the xterm DOM back from the new owner.
      if (container.contains(pty.ownedContainer)) {
        pty.unmount();
      }
      termRef.current = null;
      ptyStartedRef.current = false;
      submittedInputBufferRef.current = new SubmittedInputBuffer();
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [ptySessionId, pty]); // Re-run only when the session changes

  // 放在挂载那一段之后:同一次提交里先挂上,再按页露没露着决定用不用 WebGL(见 FrontendPty.setShown)。
  useEffect(() => {
    pty.setShown(pageShown);
    if (!pageShown) return;

    // The host grid can change while this page is retained or its window is unfocused.
    // Recalibrate even when the pane pixels stayed the same; the host drops unchanged sizes.
    scheduleLayoutMeasure();
    const view = pty.ownedContainer.ownerDocument.defaultView;
    pty.ownedContainer.addEventListener('focusin', scheduleLayoutMeasure);
    view?.addEventListener('focus', scheduleLayoutMeasure);
    return () => {
      pty.ownedContainer.removeEventListener('focusin', scheduleLayoutMeasure);
      view?.removeEventListener('focus', scheduleLayoutMeasure);
      cancelScheduledLayoutMeasure();
    };
  }, [pty, pageShown, scheduleLayoutMeasure, cancelScheduledLayoutMeasure]);

  return { focus, sendInput };
}
