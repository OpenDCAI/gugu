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
