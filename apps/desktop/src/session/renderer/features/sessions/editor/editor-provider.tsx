import { autorun, observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import type * as monacoNS from 'monaco-editor';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { registerActiveCodeEditor } from '@renderer/lib/editor/activeCodeEditor';
import { DEFAULT_EDITOR_OPTIONS } from '@renderer/lib/editor/utils';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { monacoBootstrap } from '@renderer/lib/monaco/monaco-bootstrap';
import { configureMonacoEditor } from '@renderer/lib/monaco/monaco-config';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { log } from '@renderer/utils/logger';
import { useSessionViewContext } from '../session-view-context';
import { activeFileEntry as getActiveFileEntry } from './pane-selectors';

interface EditorContextValue {
  /**
   * Ref callback that appends the pane's stable Monaco editor container to the
   * given DOM element. Called by MonacoFileRenderer to position the editor host.
   */
  setEditorHost: (el: HTMLElement | null) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditorContext must be used within EditorProvider');
  return ctx;
}

export const EditorProvider = observer(function EditorProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { sessionId } = useSessionViewContext();
  const sessionView = useWorkspaceSurface();
  const { editorView, paneLayout } = sessionView;
  const { paneId, pane: paneTabManager } = usePaneContext();
  const { effectiveTheme } = useTheme();
  const isActive = sessionView.isViewActive;

  // The directly-created Monaco editor for this pane.
  const editorRef = useRef<monacoNS.editor.IStandaloneCodeEditor | null>(null);
  // ⚠️ 同一个编辑器还要有一份**可观察**的引用:下面挂载模型的 autorun 必须能被「编辑器建好了」
  // 唤醒。编辑器改成 await Monaco 之后才创建,而 ref 不是可观察量 —— autorun 早在编辑器还是 null
  // 时就跑完了、之后再没有可观察量变化,于是模型永远挂不上:面板画得出行号,内容却是空的。
  // (sticky-diff-editor 那边一直用的就是 observable box,同一个道理。)
  // ❌ 别把这里退回只用 ref。
  const editorBoxRef = useRef(
    observable.box<monacoNS.editor.IStandaloneCodeEditor | null>(null, { deep: false })
  );
  const editorBox = editorBoxRef.current;
  // The container <div> appended to the pane's host element.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const focusPendingRef = useRef(false);

  // Stable host element provided by PaneContent via setEditorHost.
  const hostRef = useRef<HTMLElement | null>(null);

  // Tracks the previously-attached buffer URI so modelRegistry.attach can
  // save view state before switching models.
  const prevBufUriRef = useRef<string | undefined>(undefined);

  // ---------------------------------------------------------------------------
  // Theme sync — update editor theme when app theme changes.
  // When this pane's editor is created it will inherit the current theme.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    monacoBootstrap.setTheme(effectiveTheme);
  }, [effectiveTheme]);

  // ---------------------------------------------------------------------------
  // Editor creation — fires once on mount.
  //
  // ⚠️ **必须 await bootstrap,❌ 不能只读同步快照。** Monaco 是几 MB 的异步 chunk,
  // embedded.tsx 刻意不让它挡住挂载(`void monacoBootstrap.init()`),所以一个文件页签完全可能
  // 在它到达之前就挂载。上一版这里写的是 `const m = getMonaco(); if (!m) return;` —— 一次性
  // effect(deps `[]`),没赶上就**静默放弃且永不重试**:面板一直空白、控制台干净、日志干净。
  // owner 实机:「文件不渲染了」,实测 `globalThis.__monaco` 早已就绪而 `.monaco-editor` 是 0 个。
  // 那句「Monaco is guaranteed to be loaded before any pane renders」的注释在启动改成非阻塞时
  // 就已经不成立了,代码跟着注释一起过期。
  //
  // init() 失败要**响亮**:静默 return 正是这个 bug 的形状,❌ 别再吞。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    const attach = (m: typeof monacoNS) => {
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    containerRef.current = container;

    const editor = m.editor.create(container, DEFAULT_EDITOR_OPTIONS);
    editorRef.current = editor;
    runInAction(() => editorBox.set(editor));

    configureMonacoEditor(editor);

    const cleanupActive = registerActiveCodeEditor(editor);

    const focusDisposable = editor.onDidFocusEditorWidget(() => {
      sessionView.setFocusedRegion('main');
      paneLayout.setActiveGroup(paneId);
    });

    // Satisfy any focus request that arrived before the editor was ready.
    if (
      focusPendingRef.current &&
      editor.getModel() &&
      sessionNavigationFocus.focusLayer !== 'nav'
    ) {
      focusPendingRef.current = false;
      editor.focus();
    }

    if (hostRef.current) {
      hostRef.current.appendChild(container);
      editor.layout();
    }

    return () => {
      focusDisposable.dispose();
      cleanupActive();
      editor.dispose();
      container.remove();
      editorRef.current = null;
      runInAction(() => editorBox.set(null));
      containerRef.current = null;
    };
    };

    void monacoBootstrap
      .init()
      .then((m) => {
        // 卸载竞态:页签在 chunk 到达前被关掉,这里就什么都别建。
        if (disposed) return;
        teardown = attach(m);
      })
      .catch((error: unknown) => {
        log.error('[editor-provider] Monaco 加载失败,文件面板将是空的:', error);
      });

    return () => {
      disposed = true;
      teardown?.();
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Save shortcut — handle at the task-pane level so preview/source transitions
  // (notably markdown/MDX source editing) do not depend on Monaco receiving the
  // key event. 这是文件编辑器唯一的保存入口:❌ 别再给编辑器 `addCommand` 同一个键 ——
  // Monaco 的命令表是进程级的,`addCommand` 注册的命令永不注销,每次挂载都把这个
  // 组件的闭包(连同整个任务的 store)钉在内存里(#6629)。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // gugu-embedded: isActive/focusedRegion are session-page-internal and stay stale-true while the
      // whole frame is display-hidden — without this gate a Cmd+S typed in the HOST app gets
      // captured here and saves an invisible session-page file instead.
      if (!isEmbedVisible()) return;
      if (!isActive || sessionView.focusedRegion !== 'main') return;
      if (paneLayout.activePaneId !== paneId) return;
      if (event.key.toLowerCase() !== 's') return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      // 并排时可能挂着两个编辑器(两个文件并排,spec session-page「并排」):只让拿着焦点的那个文件所在的这一份接键,
      // ❌ 两份各存一遍 / 焦点在对话上也替旁边的文件存。
      const focusedId = paneTabManager.resolvedActiveTabId;
      const ownFocused = paneTabManager.activeEntryOfKind('file')?.tabId === focusedId;
      if (!ownFocused && paneTabManager.entries.get(focusedId ?? '')?.kind === 'file') return;

      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void editorView.saveAllFiles();
        return;
      }

      const entry = getActiveFileEntry(paneTabManager);
      if (!ownFocused || !entry?.bufferUri) return;

      event.preventDefault();
      event.stopPropagation();
      void editorView.saveFile(entry.bufferUri);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [editorView, paneId, isActive, paneTabManager, paneLayout, sessionView]);

  // ---------------------------------------------------------------------------
  // Model attachment — autorun that re-evaluates whenever the pane-local active
  // file or model registration status changes.
  // ---------------------------------------------------------------------------
  useEffect(
    () =>
      autorun(() => {
        const editor = editorBox.get(); // reactive —— 编辑器建好时唤醒本 autorun
        if (!editor) return;

        const entry = getActiveFileEntry(paneTabManager); // reactive
        const newBufUri = entry?.bufferUri || null;

        if (!newBufUri) {
          editor.setModel(null);
          prevBufUriRef.current = undefined;
          return;
        }

        const status = modelRegistry.modelStatus.get(newBufUri); // reactive
        if (status !== 'ready') {
          if (prevBufUriRef.current && prevBufUriRef.current !== newBufUri) {
            modelRegistry.detach(editor, prevBufUriRef.current);
            prevBufUriRef.current = undefined;
          }
          return;
        }

        modelRegistry.attach(editor, newBufUri, prevBufUriRef.current);
        prevBufUriRef.current = newBufUri;
      }),
    // oxlint-disable-next-line react/exhaustive-deps
    []
  );

  // ---------------------------------------------------------------------------
  // Restore — re-apply crash-recovery buffer content for persisted open tabs.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    void editorView.restoreBuffers();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // Focus restore — when this task becomes active and focusedRegion is 'main',
  // focus Monaco if a model is loaded; otherwise queue the intent.
  // ---------------------------------------------------------------------------
  const focusedRegion = sessionView.focusedRegion;
  useEffect(() => {
    if (!isActive || focusedRegion !== 'main' || sessionNavigationFocus.focusLayer === 'nav') return;
    // Only the focused pane should attempt to focus.
    if (paneLayout.activePaneId !== paneId) return;
    // 并排时只有拿着焦点的那个文件去抢焦点(❌ 焦点在对话上,旁边的文件把它抢走)。
    if (paneTabManager.activeEntryOfKind('file')?.tabId !== paneTabManager.resolvedActiveTabId) return;
    const editor = editorRef.current;
    if (editor?.getModel()) {
      editor.focus();
    } else {
      focusPendingRef.current = true;
    }
  }, [isActive, focusedRegion, paneId, paneLayout.activePaneId, sessionNavigationFocus.focusLayer]);

  // ---------------------------------------------------------------------------
  // setEditorHost — called by PaneContent to give the editor a stable DOM node.
  // ---------------------------------------------------------------------------
  const setEditorHost = useCallback((el: HTMLElement | null) => {
    hostRef.current = el;
    const container = containerRef.current;
    const editor = editorRef.current;
    if (el && container && editor) {
      el.appendChild(container);
      editor.layout();
    }
  }, []);

  return <EditorContext.Provider value={{ setEditorHost }}>{children}</EditorContext.Provider>;
});
