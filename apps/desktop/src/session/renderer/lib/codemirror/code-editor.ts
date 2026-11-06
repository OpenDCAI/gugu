import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import type { TextModel } from '@renderer/lib/text-model/text-model';
import { codeTheme } from './theme';

/**
 * What every code view of a file shares — the App's file editor and both diff sides: language, colours, find, completion
 * and the editing keys. Undo/redo are not here: a diff side's are its model's, the App's its own `history()`.
 */
export function codeEditing({ language, dark, editable }: {
  language: Extension;
  dark: boolean;
  editable: boolean;
}): Extension[] {
  return [
    language, codeTheme(dark), drawSelection(), EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorState.readOnly.of(!editable),
    search({ top: true }), highlightSelectionMatches(), bracketMatching(), closeBrackets(), indentOnInput(),
    autocompletion({ override: [completeAnyWord] }),
    keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap]),
  ];
}

/** `codeEditing` with undo/redo on the model (one history per file, whichever view typed). */
export function codeEditorExtensions({ model, language, dark, editable }: {
  model: TextModel;
  language: Extension;
  dark: boolean;
  editable: boolean;
}): Extension[] {
  // The key's view is the origin, so the restored cursor lands where the key was pressed.
  const undo = (target: EditorView) => { if (editable) model.undo(target); return true; };
  const redo = (target: EditorView) => { if (editable) model.redo(target); return true; };
  return [
    keymap.of([
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      { key: 'Mod-y', run: redo, preventDefault: true },
    ]),
    ...codeEditing({ language, dark, editable }),
  ];
}
