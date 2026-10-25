import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import {
  createPaneDimensionSink,
  PaneDimensionProvider,
} from '@renderer/features/tabs/pane-dimension-provider';
import { createLocalSessionMentionProvider } from '@renderer/lib/chat/local-session-mention-provider';
import { getDraggedWorkspaceFile } from '@renderer/lib/drag-files';
import { getDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { terminalSessionMentionInput } from '@renderer/lib/chat/use-session-mention-drop';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { PaneSizingContextProvider, usePaneSizingContext } from './pane-sizing-context';
import type { FrontendPty, SessionTheme } from './pty';
import { TERMINAL_CONTAINER_OVERFLOW } from './pty';
import { resolveDroppedFile } from './terminal-image-injection';
import {
  buildTerminalImageInjection,
  clipboardDataMayContainImage,
  extractClipboardImageFiles,
  formatTerminalImagePaths,
  isNearDuplicatePaste,
} from './terminal-image-paths';
import { type PasteFromClipboardHandler, usePty } from './use-pty';

type Props = {
  /**
   * Deterministic PTY session ID: `makePtySessionId(projectId, scopeId, leafId)`.
   */
  ptySessionId: string;
  /** Pre-connected FrontendPty owned by the entity's PtySession store. */
  pty: FrontendPty;
  className?: string;
  contentFilter?: string;
  mapShiftEnterToCtrlJ?: boolean;
  workspaceId: string;
  themeOverride?: SessionTheme['override'];
  onActivity?: () => void;
  onExit?: (info: { exitCode: number | undefined; signal?: number }) => void;
  onEnterPress?: (message: string) => void;
  /**
   * 粘贴图片、拖入文件时写进终端的是**本机**路径。终端连着别的机器时(#6264 SSH 直连)那些路径在对面不存在,
   * 传 false:文字与 URL 照常粘贴,本机文件路径不写过去。默认 true(本机终端)。
   */
  localPaths?: boolean;
  /**
   * 终端连着别的机器(#6264)时,粘贴 / 拖入的文件先传到那台机器,再把**那台机器上**的路径写进终端 ——
   * 与本机终端写本机路径同一个手感。给了它 `localPaths` 就应当是 false。
   */
  remoteFiles?: RemoteTerminalFiles;
};

export type RemoteTerminalFiles = {
  /** 那台机器的系统:路径按它的规矩转义。 */
  platform: NodeJS.Platform;
  /** 传过去,回那台机器上的绝对路径(失败的那几件不在里面;原因由调用方在界面上说)。 */
  upload(files: File[]): Promise<string[]>;
};

/** 系统剪贴板里的文件(截图等)读成 File —— 远端终端要把字节传过去,本机路径在那边没用。 */
async function readClipboardFiles(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const ext = type.split('/')[1]?.split('+')[0] || 'png';
      files.push(new File([blob], `pasted-image-${Date.now()}.${ext}`, { type }));
    }
    return files;
  } catch {
    return [];
  }
}

type TerminalInputHelpers = Parameters<PasteFromClipboardHandler>[0];

async function injectTerminalImagePaths(args: {
  paths: string[];
  ptySessionId: string;
  sendInput: TerminalInputHelpers['sendInput'];
  focus: TerminalInputHelpers['focus'];
}): Promise<void> {
  if (args.paths.length === 0) return;

  const platform = (await rpc.app.getPlatform()) as NodeJS.Platform;
  const payload = buildTerminalImageInjection(args.paths, platform);
  args.sendInput(`${payload} `, { track: false });
  args.focus();
}

// Returns true only when an image was injected, so callers can scope their
// duplicate-paste guard to the image path and leave plain-text pastes unguarded.
async function pasteClipboardImageOrText(args: {
  ptySessionId: string;
  sendInput: TerminalInputHelpers['sendInput'];
  focus: TerminalInputHelpers['focus'];
  fallbackText?: string;
  preferText?: boolean;
  // Re-checked right before injecting an image; the image branch resolves
  // asynchronously, so a competing paste path may have injected in the meantime.
  shouldInjectImage?: () => boolean;
}): Promise<boolean> {
  if (args.preferText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        args.sendInput(text);
        return false;
      }
    } catch {
      // Clipboard text read denied or unavailable; try the image path below.
    }
  }

  try {
    const result = await rpc.pty.persistClipboardImage();
    if (result.success && result.data.path) {
      if (args.shouldInjectImage && !args.shouldInjectImage()) return false;
      await injectTerminalImagePaths({ ...args, paths: [result.data.path] });
      return true;
    }
  } catch (error) {
    log.warn('Terminal clipboard image paste failed', { error });
  }

  if (args.fallbackText !== undefined) {
    if (args.fallbackText) args.sendInput(args.fallbackText);
    return false;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text) args.sendInput(text);
  } catch {
    // Clipboard read denied or unavailable.
  }
  return false;
}

const PtyPaneInner = forwardRef<{ focus: () => void }, Props>(
  (
    {
      ptySessionId,
      pty,
      className,
      contentFilter,
      mapShiftEnterToCtrlJ,
      workspaceId,
      themeOverride,
      onActivity,
      onExit,
      onEnterPress,
      localPaths = true,
      remoteFiles,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const lastDomImagePasteAtRef = useRef(0);
    const lastSystemPasteAtRef = useRef(0);

    const theme: SessionTheme = { override: themeOverride };

    /** 远端终端:文件先传到那台机器,再把那边的路径按本机拖入同一个形状写进终端。 */
    const injectRemoteFiles = useCallback(
      async (files: File[], io: Pick<TerminalInputHelpers, 'focus' | 'sendInput'>): Promise<void> => {
        if (!remoteFiles || files.length === 0) return;
        try {
          const paths = await remoteFiles.upload(files);
          if (paths.length === 0) return;
          io.sendInput(`${buildTerminalImageInjection(paths, remoteFiles.platform)} `, { track: false });
          io.focus();
        } catch (error) {
          log.warn('Remote terminal file upload failed', { error });
        }
      },
      [remoteFiles]
    );

    const handleSystemPaste = useCallback<PasteFromClipboardHandler>(
      ({ focus, sendInput }) => {
        if (!localPaths) {
          void (async () => {
            const text = await navigator.clipboard.readText().catch(() => '');
            if (text) {
              sendInput(text);
              return;
            }
            // 远端终端:剪贴板里是一张图(截图)⇒ 传到那台机器,写那边的路径。
            if (!remoteFiles || isNearDuplicatePaste(lastDomImagePasteAtRef.current)) return;
            const files = await readClipboardFiles();
            if (files.length === 0) return;
            lastSystemPasteAtRef.current = Date.now();
            await injectRemoteFiles(files, { focus, sendInput });
          })();
          return;
        }
        if (isNearDuplicatePaste(lastDomImagePasteAtRef.current)) return;
        void (async () => {
          const injectedImage = await pasteClipboardImageOrText({
            ptySessionId,
            focus,
            sendInput,
            preferText: true,
            shouldInjectImage: () => !isNearDuplicatePaste(lastDomImagePasteAtRef.current),
          });
          // Only guard the DOM image path against a system paste that actually
          // injected an image; plain-text pastes must not block it.
          if (injectedImage) lastSystemPasteAtRef.current = Date.now();
        })();
      },
      [ptySessionId, localPaths, remoteFiles, injectRemoteFiles]
    );

    const { focus, sendInput } = usePty(
      {
        ptySessionId,
        pty,
        theme,
        mapShiftEnterToCtrlJ,
        onActivity,
        onExit,
        onEnterPress,
        onPasteFromClipboard: handleSystemPaste,
      },
      containerRef
    );

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    const injectImagePaths = useCallback(
      async (paths: string[]) => {
        await injectTerminalImagePaths({
          paths,
          ptySessionId,
          focus,
          sendInput,
        });
      },
      [focus, sendInput, ptySessionId]
    );

    const injectImageFiles = useCallback(
      async (files: File[]): Promise<boolean> => {
        const resolved = await Promise.all(files.map((file) => resolveDroppedFile(file)));
        const paths = resolved.filter((path): path is string => Boolean(path));
        if (paths.length === 0) return false;
        await injectImagePaths(paths);
        return true;
      },
      [injectImagePaths]
    );

    const handleFocus = () => {
      focus();
    };

    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>) => {
        // 远端终端:文字交给终端自己的粘贴;文件(截图、从访达复制的文件)传到那台机器、写那边的路径,
        // ❌ 把本机路径写过去(那台机器上没有这些文件)。
        if (!localPaths) {
          const files = remoteFiles ? Array.from(event.clipboardData?.files ?? []) : [];
          if (files.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          if (isNearDuplicatePaste(lastSystemPasteAtRef.current)) return;
          lastDomImagePasteAtRef.current = Date.now();
          void injectRemoteFiles(files, { focus, sendInput });
          return;
        }
        const clipboardData = event.clipboardData;
        const fallbackText = clipboardData?.getData('text/plain') ?? '';
        const imageFiles = extractClipboardImageFiles(clipboardData);
        if (imageFiles.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          if (isNearDuplicatePaste(lastSystemPasteAtRef.current)) return;
          lastDomImagePasteAtRef.current = Date.now();
          void (async () => {
            try {
              const injected = await injectImageFiles(imageFiles);
              if (injected) return;
              await pasteClipboardImageOrText({
                ptySessionId,
                focus,
                sendInput,
                fallbackText,
              });
            } catch (error) {
              log.warn('Terminal image paste failed', { error });
            }
          })();
          return;
        }

        if (!clipboardDataMayContainImage(clipboardData)) return;

        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        if (isNearDuplicatePaste(lastSystemPasteAtRef.current)) return;
        lastDomImagePasteAtRef.current = Date.now();
        void pasteClipboardImageOrText({
          ptySessionId,
          focus,
          sendInput,
          fallbackText,
        });
      },
      [focus, injectImageFiles, sendInput, ptySessionId, localPaths, remoteFiles, injectRemoteFiles]
    );

    const handleDrop: React.DragEventHandler<HTMLDivElement> = (event) => {
      try {
        event.preventDefault();
        const dt = event.dataTransfer;
        if (!dt) return;
        // A resource URL is text, on this machine or another, just as a text paste is.
        const uri = dt.files?.length ? '' : dt.getData('text/uri-list');
        if (uri) {
          sendInput(dt.getData('text/plain') || uri);
          focus();
          return;
        }
        // 远端终端:会话、工作区文件是本机的东西,对面用不了;OS 文件传到那台机器、写那边的路径。
        if (!localPaths) {
          if (remoteFiles && dt.files?.length) void injectRemoteFiles(Array.from(dt.files), { focus, sendInput });
          return;
        }

        // 侧栏会话行拖进来 = 在这条终端里写下对方的 @(behavior session-page「把会话拖成 @」)。
        // 编程形态的会话没有 composer,终端**就是**输入框 —— 落点只做在聊天框上,拖到这里
        // 会一声不响地什么都不发生(owner 2026-09-16 实撞:他那两条会话都是终端形态)。
        // 写进去的是**寻址名**(Codex 1 / Claude 1),不是 uuid:spec session-page-comm ⑨ 定的
        // 就是「可读名即寻址名,agent 到通讯录里按名字查回 ID」,而终端里没有 pill 能替 uuid 挡脸。
        const draggedSession = getDraggedScreenContent(dt);
        if (draggedSession?.kind === 'session') {
          void (async () => {
            try {
              const mention = await createLocalSessionMentionProvider().resolveSession(
                draggedSession.sessionId
              );
              const input = terminalSessionMentionInput(mention);
              if (!input) {
                log.warn('Dragged session has no local identity yet', {
                  sessionId: draggedSession.sessionId,
                });
                return;
              }
              sendInput(input, { track: false });
              focus();
            } catch (error) {
              log.warn('Terminal session-mention drop failed', { error });
            }
          })();
          return;
        }

        // In-app drag from the editor file tree. The drag payload already
        // carries the path in the workspace environment where this agent runs.
        const draggedWorkspaceFile = getDraggedWorkspaceFile(dt);
        if (draggedWorkspaceFile) {
          if (draggedWorkspaceFile.workspaceId !== workspaceId) return;

          void (async () => {
            try {
              const platform =
                draggedWorkspaceFile.targetPlatform ??
                ((await rpc.app.getPlatform()) as NodeJS.Platform);
              // Plain text, not bracketed paste: Claude Code swallows externally
              // injected paste markers, and the escaped single-line path needs
              // no paste protection in shells or other agent TUIs.
              sendInput(
                `${formatTerminalImagePaths([draggedWorkspaceFile.targetPath], platform)} `,
                {
                  track: false,
                }
              );
              focus();
            } catch (error) {
              log.warn('Terminal drop failed', { error });
            }
          })();
          return;
        }

        if (!dt.files?.length) return;

        const files = Array.from(dt.files);

        void (async () => {
          try {
            const resolved = await Promise.all(files.map((file) => resolveDroppedFile(file)));
            const paths = resolved.filter((path): path is string => Boolean(path));
            if (paths.length === 0) return;
            await injectImagePaths(paths);
          } catch (error) {
            log.warn('Terminal drop failed', { error });
          }
        })();
      } catch (error) {
        log.warn('Terminal drop failed', { error });
      }
    };

    return (
      <div
        className={cn('terminal-pane flex h-full w-full min-w-0 bg', className)}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          backgroundColor: themeOverride?.background ? `var(${themeOverride.background})` : 'var(--background-secondary)',
        }}
      >
        <div
          ref={containerRef}
          data-terminal-container
          className={cn('min-w-0', themeOverride?.background ? '' : 'bg-background-secondary-1')}
          style={{
            width: '100%',
            height: '100%',
            minWidth: 0,
            minHeight: 0,
            overflow: TERMINAL_CONTAINER_OVERFLOW,
            filter: contentFilter || undefined,
          }}
          onClick={handleFocus}
          onMouseDown={handleFocus}
          onPasteCapture={handlePaste}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        />
      </div>
    );
  }
);

PtyPaneInner.displayName = 'TerminalPane';

/**
 * Outer wrapper: guarantees a PaneSizingContext (and therefore the per-pane
 * resize controller) is always present. When a PaneSizingContextProvider
 * ancestor already exists (e.g. sessions-panel, terminal drawer) the
 * children use that context unchanged. When none exists, PtyPane self-provisions
 * a provider scoped to its own single session ID so there is always exactly one
 * measurement path through the controller.
 */
const PtyPaneComponent = forwardRef<{ focus: () => void }, Props>((props, ref) => {
  const existing = usePaneSizingContext();
  const sink = useMemo(() => createPaneDimensionSink(), []);
  const ptySessionIds = useMemo(() => [props.ptySessionId], [props.ptySessionId]);

  if (existing) return <PtyPaneInner {...props} ref={ref} />;
  return (
    <PaneDimensionProvider sink={sink}>
      <PaneSizingContextProvider ptySessionIds={ptySessionIds}>
        <PtyPaneInner {...props} ref={ref} />
      </PaneSizingContextProvider>
    </PaneDimensionProvider>
  );
});
PtyPaneComponent.displayName = 'PtyPane';

export const PtyPane = React.memo(PtyPaneComponent);
