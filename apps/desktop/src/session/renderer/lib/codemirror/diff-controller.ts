import { goToNextChunk, goToPreviousChunk, MergeView, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge';
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { registerCodeEditorHistory } from '@renderer/lib/editor/activeCodeEditor';
import type { DiffSideState, DiffViewState } from '@renderer/lib/editor/diff-view-state';
import type { TextModel } from '@renderer/lib/text-model/text-model';
import { codeEditorExtensions } from './code-editor';
import { bindModel } from './model-binding';
import { diffOverview } from './diff-overview';

export function createDiffController({ parent, original, modified, style, language, dark, saved, save }: {
  parent: HTMLElement;
  original: TextModel;
  modified: TextModel;
  style: 'split' | 'unified';
  language: Extension;
  dark: boolean;
  saved: DiffViewState | undefined;
  save: () => void;
}) {
  const writable = modified.writable;
  const cleanups: Array<() => void> = [];
  // One overview ruler, on the modified side (the only side in unified mode).
  const extensions = (model: TextModel, editable: boolean, overview: boolean): Extension[] => [
    keymap.of([
      { key: 'Mod-s', run: () => { if (editable) save(); return true; } },
      { key: 'Alt-F5', run: goToNextChunk }, { key: 'Alt-Shift-F5', run: goToPreviousChunk },
    ]),
    lineNumbers(), overview ? diffOverview : [],
    codeEditorExtensions({ model, language, dark, editable }),
  ];
  const config = (model: TextModel, editable: boolean, overview: boolean) => ({
    doc: model.doc, extensions: extensions(model, editable, overview),
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
    cleanups.push(bindModel(left, original));
    destroy = () => merge.destroy();
  } else {
    right = new EditorView({ parent, doc: modified.doc, extensions: [
      extensions(modified, writable, true), unifiedMergeView({ original: original.doc, mergeControls: false }),
    ] });
    right.dom.style.height = '100%';
    scroll = right.scrollDOM;
    cleanups.push(original.onDidChange(({ changes }) => {
      right.dispatch({ effects: originalDocChangeEffect(right.state, changes) });
    }));
    destroy = () => right.destroy();
  }
  cleanups.push(bindModel(right, modified));
  for (const [view, model, editable] of [[left, original, false], [right, modified, writable]] as const) {
    if (!view) continue;
    cleanups.push(registerCodeEditorHistory({
      hasFocus: () => editable && view.hasFocus,
      undo: () => { model.undo(view); }, redo: () => { model.redo(view); },
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
