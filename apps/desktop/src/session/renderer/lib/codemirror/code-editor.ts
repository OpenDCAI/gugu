import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import type { TextModel } from '@renderer/lib/text-model/text-model';
import { codeTheme } from './theme';

/**
 * What every code view of a file shares — the file editor and both diff sides: language, colours, find, completion and
 * the editing keys. Undo/redo are the model's (one history per file, whichever view typed), so they are bound here
 * instead of CodeMirror's own `history()`.
 */
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
    language, codeTheme(dark), drawSelection(), EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorState.readOnly.of(!editable),
    search({ top: true }), highlightSelectionMatches(), bracketMatching(), closeBrackets(), indentOnInput(),
    autocompletion({ override: [completeAnyWord] }),
    keymap.of([
      { key: 'Mod-z', run: undo, preventDefault: true },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      { key: 'Mod-y', run: redo, preventDefault: true },
      ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap,
    ]),
  ];
}
