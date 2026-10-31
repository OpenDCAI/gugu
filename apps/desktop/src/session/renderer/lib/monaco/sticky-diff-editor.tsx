import { autorun, observable, runInAction } from 'mobx';
import type * as monacoNS from 'monaco-editor';
import { useEffect, useRef } from 'react';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { monacoBootstrap } from '@renderer/lib/monaco/monaco-bootstrap';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { log } from '@renderer/utils/logger';
import { DIFF_EDITOR_BASE_OPTIONS } from './editorConfig';

export interface StickyDiffEditorProps {
  /** URI for the left (original/before) side — typically git:// */
  originalUri: string;
  /** URI for the right (modified/after) side — disk://, git://, etc. */
  modifiedUri: string;
  diffStyle: 'unified' | 'split';
  /** Called whenever the content height changes, for auto-sizing parent containers. */
  onHeightChange?: (height: number) => void;
  /** Called when the diff editor instance is created/disposed. */
  onEditorChange?: (editor: monacoNS.editor.IStandaloneDiffEditor | null) => void;
}

export function StickyDiffEditor({
  originalUri,
  modifiedUri,
  diffStyle,
  onHeightChange,
  onEditorChange,
}: StickyDiffEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const modifiedUriRef = useRef(modifiedUri);
  modifiedUriRef.current = modifiedUri;

  // Observable box so the autorun can react to the editor arriving after async mount.
  const editorBox = useRef(
    observable.box<monacoNS.editor.IStandaloneDiffEditor | null>(null)
  ).current;

  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;

  const onEditorChangeRef = useRef(onEditorChange);
  onEditorChangeRef.current = onEditorChange;

  const { effectiveTheme } = useTheme();

  // Create editor once on mount, dispose on unmount.
  //
  // ⚠️ **必须 await bootstrap,❌ 不能只读同步快照。** Monaco 是几 MB 的异步 chunk,
  // embedded.tsx 刻意不让它挡住挂载,所以这个组件完全可能在它到达之前就挂载。上一版写的是
  // `getMonaco(); if (!m) return;` —— 一次性 effect,没赶上就静默放弃且永不重试,diff 面板
  // 一直空白、还不报错(文件编辑器那边同一份写法已经被 owner 实机撞到:「文件不渲染了」)。
  // 那句「guaranteed ready because init() is awaited in main.tsx」的注释在启动改成非阻塞时
  // 就已经不成立了。
  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    const attach = (m: typeof monacoNS) => {
    if (!mountRef.current) return undefined;

    const editor = m.editor.createDiffEditor(mountRef.current, {
      ...DIFF_EDITOR_BASE_OPTIONS,
      readOnly: !modifiedUriRef.current.startsWith('file://'),
      renderSideBySide: diffStyle === 'split',
    });
    onEditorChangeRef.current?.(editor);

    const modifiedEditor = editor.getModifiedEditor();
    // ❌ 别用 addCommand:它注册进进程级命令表后永不注销,这个闭包连同整个 diff 编辑器会
    // 一直被钉在内存里(#6629)。addAction 返回的注册随卸载一起 dispose。
    const saveAction = modifiedEditor.addAction({
      id: 'gugu.diff.save',
      label: 'Save',
      keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.KeyS],
      run: () => {
        const uri = modifiedUriRef.current;
        if (!uri.startsWith('file://')) return;
        void modelRegistry.saveFileToDisk(uri);
      },
    });

    const heightDisposable = modifiedEditor.onDidContentSizeChange(
      (e: { contentHeightChanged: boolean; contentHeight: number }) => {
        if (e.contentHeightChanged) {
          onHeightChangeRef.current?.(e.contentHeight);
        }
      }
    );

    runInAction(() => editorBox.set(editor));

    return () => {
      onEditorChangeRef.current?.(null);
      saveAction.dispose();
      heightDisposable.dispose();
      runInAction(() => editorBox.set(null));
      editor.dispose();
    };
    };

    void monacoBootstrap
      .init()
      .then((m) => {
        if (disposed) return;
        teardown = attach(m);
      })
      .catch((error: unknown) => {
        log.error('[sticky-diff-editor] Monaco 加载失败,diff 面板将是空的:', error);
      });

    return () => {
      disposed = true;
      teardown?.();
    };
  }, []);

  // Sync diffStyle changes to the mounted editor.
  useEffect(() => {
    editorBox.get()?.updateOptions({ renderSideBySide: diffStyle === 'split' });
  }, [diffStyle, editorBox]);

  useEffect(() => {
    editorBox.get()?.updateOptions({ readOnly: !modifiedUri.startsWith('file://') });
  }, [modifiedUri, editorBox]);

  // Sync global Monaco theme (affects all editor instances simultaneously).
  useEffect(() => {
    monacoBootstrap.setTheme(effectiveTheme);
  }, [effectiveTheme]);

  // Reactive content application — recreated when URIs change.
  // The autorun waits for both models to be 'ready' in the registry, then calls
  // setModel in-place without remounting the editor component.
  useEffect(() => {
    // Clear the previously-attached models synchronously on URI change so the
    // editor doesn't keep showing the previous file's content while the new
    // models are still loading.
    const current = editorBox.get();
    if (current) {
      const prev = current.getModel();
      if (prev) {
        current.setModel(null);
        if (prev.original.uri.scheme === 'inmemory') prev.original.dispose();
        if (prev.modified.uri.scheme === 'inmemory') prev.modified.dispose();
      }
    }

    const disposer = autorun(() => {
      const editor = editorBox.get(); // reactive: waits for editor to exist
      if (!editor) return;

      const origStatus = modelRegistry.modelStatus.get(originalUri); // reactive
      const modStatus = modelRegistry.modelStatus.get(modifiedUri); // reactive
      if (origStatus !== 'ready' || modStatus !== 'ready') return;

      const origModel = modelRegistry.getModelByUri(originalUri);
      const modModel = modelRegistry.getModelByUri(modifiedUri);
      if (!origModel || !modModel) return;

      const attached = editor.getModel();
      if (attached?.original === origModel && attached?.modified === modModel) return;

      // Clean up any previous inmemory models to avoid leaks (mirrors applyContent).
      if (attached) {
        editor.setModel(null);
        if (attached.original.uri.scheme === 'inmemory') attached.original.dispose();
        if (attached.modified.uri.scheme === 'inmemory') attached.modified.dispose();
      }

      editor.setModel({ original: origModel, modified: modModel });
      editor.layout();
      // Restore scroll/cursor for the incoming URI pair.
      modelRegistry.restoreDiffViewState(originalUri, modifiedUri, editor);
      onHeightChangeRef.current?.(editor.getModifiedEditor().getContentHeight());
    });

    return () => {
      // On unmount or URI change: save the current viewport so it can be restored later.
      const ed = editorBox.get();
      if (ed?.getModel()) modelRegistry.saveDiffViewState(originalUri, modifiedUri, ed);
      disposer();
    };
    // editorBox is a stable ref created once; only URI changes recreate the autorun.
  }, [originalUri, modifiedUri]);

  return <div ref={mountRef} className="h-full" />;
}
