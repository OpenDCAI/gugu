import type * as monaco from 'monaco-editor';

interface CodeEditorHistory {
  hasFocus(): boolean;
  undo(): void;
  redo(): void;
}

let activeEditor: CodeEditorHistory | null = null;

export function registerCodeEditorHistory(editor: CodeEditorHistory, subscribe: (listener: () => void) => () => void): () => void {
  const dispose = subscribe(() => { activeEditor = editor; });
  if (editor.hasFocus()) activeEditor = editor;
  return () => {
    dispose();
    if (activeEditor === editor) activeEditor = null;
  };
}

function isEditorFocused(editor: monaco.editor.ICodeEditor | null): boolean {
  if (!editor) return false;

  try {
    if (typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) return true;
  } catch {}

  try {
    if (typeof editor.hasWidgetFocus === 'function' && editor.hasWidgetFocus()) return true;
  } catch {}

  return false;
}

export function registerActiveCodeEditor(editor: monaco.editor.ICodeEditor | null): () => void {
  if (!editor) return () => {};
  return registerCodeEditorHistory({
    hasFocus: () => isEditorFocused(editor),
    undo: () => editor.trigger('menu', 'undo', null),
    redo: () => editor.trigger('menu', 'redo', null),
  }, listener => {
    const subscription = editor.onDidFocusEditorText(listener);
    return () => subscription.dispose();
  });
}

export function performActiveEditorUndo(): boolean {
  const editor = activeEditor;
  if (!editor?.hasFocus()) return false;
  try {
    editor.undo();
    return true;
  } catch {
    return false;
  }
}

export function performActiveEditorRedo(): boolean {
  const editor = activeEditor;
  if (!editor?.hasFocus()) return false;
  try {
    editor.redo();
    return true;
  } catch {
    return false;
  }
}
