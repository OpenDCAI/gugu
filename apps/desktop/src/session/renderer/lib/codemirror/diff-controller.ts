import { autocompletion, completeAnyWord, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { getOriginalDoc, goToNextChunk, goToPreviousChunk, MergeView, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState, Text, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import type * as Monaco from 'monaco-editor';
import { registerCodeEditorHistory } from '@renderer/lib/editor/activeCodeEditor';
import type { DiffSideState, DiffViewState } from '@renderer/lib/editor/diff-view-state';
import { bindModel, modelChanges } from './model-binding';
import { diffOverview } from './diff-overview';
import { diffTheme } from './diff-theme';

export function createDiffController({ parent, monaco, original, modified, style, language, dark, saved, save }: {
  parent: HTMLElement;
  monaco: typeof Monaco;
  original: Monaco.editor.ITextModel;
  modified: Monaco.editor.ITextModel;
  style: 'split' | 'unified';
  language: Extension;
  dark: boolean;
  saved: DiffViewState | undefined;
  save: () => void;
}) {
  const writable = modified.uri.scheme === 'file';
  const cleanups: Array<() => void> = [];
  // Like Monaco's diff, one overview ruler: on the modified side (the only side in unified mode).
  const extensions = (model: Monaco.editor.ITextModel, editable: boolean, overview: boolean): Extension[] => [
    language, diffTheme(dark), lineNumbers(), drawSelection(), EditorView.lineWrapping,
    EditorState.readOnly.of(!editable),
    search({ top: true }), overview ? diffOverview : [],
    autocompletion({ override: [completeAnyWord] }),
    keymap.of([
      { key: 'Mod-s', run: () => { if (editable) save(); return true; } },
      { key: 'Mod-z', run: () => { if (editable) { model.pushStackElement(); void model.undo(); } return true; } },
      { key: 'Mod-Shift-z', run: () => { if (editable) void model.redo(); return true; } },
      { key: 'Mod-y', run: () => { if (editable) void model.redo(); return true; } },
      { key: 'Alt-F5', run: goToNextChunk }, { key: 'Alt-Shift-F5', run: goToPreviousChunk },
      ...completionKeymap, ...searchKeymap, indentWithTab, ...defaultKeymap,
    ]),
  ];
  const config = (model: Monaco.editor.ITextModel, editable: boolean, overview: boolean) => ({
    doc: Text.of(model.getLinesContent()), extensions: extensions(model, editable, overview),
  });
  let left: EditorView | null = null;
  let right: EditorView;
  let scroll: HTMLElement;
  let destroy: () => void;
  if (style === 'split') {
    const merge = new MergeView({ parent, a: config(original, false, false), b: config(modified, writable, true) });
    left = merge.a;
    right = merge.b;
    scroll = merge.dom;
    merge.dom.style.cssText = 'height:100%;overflow:auto';
    cleanups.push(bindModel(left, original, monaco));
    destroy = () => merge.destroy();
  } else {
    right = new EditorView({ parent, doc: Text.of(modified.getLinesContent()), extensions: [
      extensions(modified, writable, true), unifiedMergeView({ original: Text.of(original.getLinesContent()), mergeControls: false }),
    ] });
    right.dom.style.height = '100%';
    scroll = right.scrollDOM;
    const subscription = original.onDidChangeContent(event => {
      right.dispatch({ effects: originalDocChangeEffect(right.state, modelChanges(getOriginalDoc(right.state), event)) });
    });
    cleanups.push(() => subscription.dispose());
    destroy = () => right.destroy();
  }
  cleanups.push(bindModel(right, modified, monaco));
  for (const [view, model, editable] of [[left, original, false], [right, modified, writable]] as const) {
    if (!view) continue;
    cleanups.push(registerCodeEditorHistory({
      hasFocus: () => editable && view.hasFocus,
      undo: () => { model.pushStackElement(); void model.undo(); }, redo: () => { void model.redo(); },
    }, listener => {
      view.contentDOM.addEventListener('focus', listener);
      return () => view.contentDOM.removeEventListener('focus', listener);
    }));
  }
  const restore = (view: EditorView, state: DiffSideState | null | undefined) => {
    if (!state) return;
    const ranges = state.ranges.map(range => EditorSelection.range(Math.min(range.anchor, view.state.doc.length), Math.min(range.head, view.state.doc.length)));
    view.dispatch({ selection: EditorSelection.create(ranges, state.mainIndex) });
  };
  if (left) restore(left, saved?.original);
  restore(right, saved?.modified);
  if (saved) right.requestMeasure({ read: () => null, write: () => {
    scroll.scrollTop = saved.scrollTop;
    right.scrollDOM.scrollLeft = saved.modified.scrollLeft;
    if (left && saved.original) left.scrollDOM.scrollLeft = saved.original.scrollLeft;
  } });
  const snapshot = (view: EditorView): DiffSideState => ({
    ranges: view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
    mainIndex: view.state.selection.mainIndex, scrollLeft: view.scrollDOM.scrollLeft,
  });
  return {
    snapshot: (): DiffViewState => ({ original: left ? snapshot(left) : saved?.original ?? null, modified: snapshot(right), scrollTop: scroll.scrollTop }),
    destroy: () => { cleanups.forEach(dispose => dispose()); destroy(); },
  };
}
