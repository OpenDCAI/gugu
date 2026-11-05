import { autorun, observable, runInAction, untracked } from 'mobx';
import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { createFileEditor, FILE_EDITOR_FONT_SIZE, runEditAction, type FileEditor } from '@renderer/lib/codemirror/file-editor';
import { registerCodeEditorHistory } from '@renderer/lib/editor/activeCodeEditor';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { modelRegistry } from '@renderer/lib/text-model/model-registry';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { useSessionViewContext } from '../session-view-context';
import { activeFileResource } from './pane-selectors';
import { bindFileViewerMenu } from '@/components/preview/file-viewer-menu';
import { notify } from '@/lib/notices';
import { bindEditorFileZoom } from '@/components/preview/file-content-zoom';
import { quoteWorkspaceFile } from '@renderer/lib/editor/quote-workspace-file';

interface EditorContextValue {
  /**
   * Ref callback that appends the pane's stable editor container to the
   * given DOM element. Called by FileContentRenderer to position the editor host.
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

  // The pane's one file editor view; files swap in as states (`attachModel`).
  const editorRef = useRef<FileEditor | null>(null);
  // ⚠️ 同一个编辑器还要有一份**可观察**的引用:下面挂载模型的 autorun 必须能被「编辑器建好了」唤醒 ——
  // ref 不是可观察量,autorun 若在编辑器还是 null 时跑完,之后再没有可观察量变化,模型就永远挂不上。
  // ❌ 别把这里退回只用 ref。
  const editorBoxRef = useRef(observable.box<FileEditor | null>(null, { deep: false }));
  const editorBox = editorBoxRef.current;
  const focusPendingRef = useRef(false);

  // Stable host element provided by PaneContent via setEditorHost.
  const hostRef = useRef<HTMLElement | null>(null);

  // Theme sync — the editor takes the current theme when created and follows it after.
  const dark = effectiveTheme !== 'emlight';
  useEffect(() => {
    editorRef.current?.setDark(dark);
  }, [dark]);

  // ---------------------------------------------------------------------------
  // Editor creation — once on mount.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const editor = createFileEditor({ dark });
    const { container, view } = editor;
    const offZoom = bindEditorFileZoom(container, editor.setFontSize, FILE_EDITOR_FONT_SIZE);
    editorRef.current = editor;
    runInAction(() => editorBox.set(editor));

    const cleanupHistory = registerCodeEditorHistory({
      hasFocus: () => view.hasFocus,
      undo: () => { editor.model?.undo(view); },
      redo: () => { editor.model?.redo(view); },
    }, listener => {
      view.contentDOM.addEventListener('focus', listener);
      return () => view.contentDOM.removeEventListener('focus', listener);
    });
    const cleanupMenu = bindFileViewerMenu(container, () => {
      const file = activeFileResource(paneTabManager);
      const model = editor.model;
      if (!file || !model) throw new Error('The file editor is no longer available');
      const { doc, selection } = view.state;
      const range = selection.main;
      const first = doc.lineAt(range.from).number;
      const endLine = doc.lineAt(range.to);
      const last = endLine.number > first && range.to === endLine.from ? endLine.number - 1 : endLine.number;
      const path = file.path;
      const editable = model.writable;
      const focusCaptured = () => {
        if (editor.model !== model) throw new Error('The file editor changed');
        view.focus();
        view.dispatch({ selection });
      };
      return {
        selection: { text: doc.sliceString(range.from, range.to), at: { lines: first === last ? String(last) : `${first}-${last}` } },
        quote: (quoted) => quoteWorkspaceFile(sessionView.projectId, sessionId, path, quoted),
        selectAll: () => { focusCaptured(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); },
        editable,
        enabled: { cut: editable && !range.empty, copy: !range.empty, selectAll: doc.length > 0 },
        editorHistory: { undo: editable && model.canUndo, redo: editable && model.canRedo },
        edit: (action) => {
          focusCaptured();
          void runEditAction(view, model, action).catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }));
        },
      };
    }, (error) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }));

    const onFocus = () => {
      sessionView.setFocusedRegion('main');
      paneLayout.setActiveGroup(paneId);
    };
    view.contentDOM.addEventListener('focus', onFocus);

    if (hostRef.current) hostRef.current.appendChild(container);

    return () => {
      view.contentDOM.removeEventListener('focus', onFocus);
      cleanupMenu();
      cleanupHistory();
      offZoom();
      editor.destroy();
      editorRef.current = null;
      runInAction(() => editorBox.set(null));
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Save shortcut — handle at the task-pane level so preview/source transitions
  // (notably markdown/MDX source editing) do not depend on the editor receiving the
  // key event. 这是文件编辑器唯一的保存入口:❌ 别再给编辑器的 keymap 绑同一个键(两处都存一遍)。
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

      const entry = activeFileResource(paneTabManager);
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

        const entry = activeFileResource(paneTabManager); // reactive
        const bufferUri = entry?.bufferUri || null;
        // Not ready (or no file): keep nothing attached, so the editor never shows the file you looked at before.
        const ready = bufferUri !== null && modelRegistry.modelStatus.get(bufferUri) === 'ready'; // reactive
        const model = ready ? modelRegistry.getModelByUri(bufferUri) ?? null : null;
        untracked(() => {
          editor.attach(model, model ? modelRegistry.viewState(model.uri) : null, (uri, state) => modelRegistry.saveViewState(uri, state));
          // Satisfy a focus request that arrived before the file was ready.
          if (model && focusPendingRef.current && sessionNavigationFocus.focusLayer !== 'nav') {
            focusPendingRef.current = false;
            editor.view.focus();
          }
        });
      }),
    []
  );

  // ---------------------------------------------------------------------------
  // Restore — re-apply crash-recovery buffer content for persisted open tabs.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    void editorView.restoreBuffers();
  }, [sessionId]);

  // ---------------------------------------------------------------------------
  // Focus restore — when this task becomes active and focusedRegion is 'main',
  // focus the editor if a model is loaded; otherwise queue the intent.
  // ---------------------------------------------------------------------------
  const focusedRegion = sessionView.focusedRegion;
  useEffect(() => {
    if (!isActive || focusedRegion !== 'main' || sessionNavigationFocus.focusLayer === 'nav') return;
    // Only the focused pane should attempt to focus.
    if (paneLayout.activePaneId !== paneId) return;
    // 并排时只有拿着焦点的那个文件去抢焦点(❌ 焦点在对话上,旁边的文件把它抢走)。
    if (paneTabManager.activeEntryOfKind('file')?.tabId !== paneTabManager.resolvedActiveTabId) return;
    const editor = editorRef.current;
    if (editor?.model) {
      editor.view.focus();
    } else {
      focusPendingRef.current = true;
    }
  }, [isActive, focusedRegion, paneId, paneLayout.activePaneId, sessionNavigationFocus.focusLayer]);

  // ---------------------------------------------------------------------------
  // setEditorHost — called by PaneContent to give the editor a stable DOM node.
  // ---------------------------------------------------------------------------
  const setEditorHost = useCallback((el: HTMLElement | null) => {
    hostRef.current = el;
    const editor = editorRef.current;
    if (el && editor) el.appendChild(editor.container);
  }, []);

  return <EditorContext.Provider value={{ setEditorHost }}>{children}</EditorContext.Provider>;
});
