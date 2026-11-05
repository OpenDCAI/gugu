import { EditorSelection, EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine } from '@codemirror/view';
import { platform } from '@/platform';
import type { FileViewerEditAction } from '@/session/shared/preview/file-viewer-menu';
import type { FileViewState } from '@renderer/lib/editor/diff-view-state';
import type { TextModel } from '@renderer/lib/text-model/text-model';
import { log } from '@renderer/utils/logger';
import { codeEditorExtensions } from './code-editor';
import { loadLanguage } from './languages';
import { bindModel } from './model-binding';
import { codeTheme } from './theme';

export const FILE_EDITOR_FONT_SIZE = 13;

/**
 * 文件查看面板是**读文件**的面板,不是全屏 IDE 主编辑区:它常年只有几百像素宽,右边还挨着文件树。
 * 所以没有行号槽、没有 minimap / overview ruler(实机量过,那几样在 178px 宽时吃掉 115px,正文只剩 63px);
 * 左右各留 16px 阅读留白,上下 16px。行号只在审阅的 diff 里有(那里要对行)。
 */
const readingLayout = EditorView.theme({
  '&': { height: '100%' },
  '.cm-content': { padding: '16px 0' },
  '.cm-line': { padding: '0 16px' },
});

export interface FileEditor {
  readonly container: HTMLDivElement;
  readonly view: EditorView;
  /** The file shown now, or null (nothing open, or its model is not ready). */
  readonly model: TextModel | null;
  /** Show `model` (restoring `saved`); the file shown before hands its cursor and scroll to `save`. */
  attach(model: TextModel | null, saved: FileViewState | null, save: (uri: string, state: FileViewState) => void): void;
  setDark(dark: boolean): void;
  setFontSize(px: number): void;
  destroy(): void;
}

/** A pane's one file editor: a single view that files swap into, so switching tabs never rebuilds it. */
export function createFileEditor({ dark: initialDark }: { dark: boolean }): FileEditor {
  const container = document.createElement('div');
  container.style.width = '100%';
  container.style.height = '100%';
  const config = new Compartment();
  let dark = initialDark;
  let model: TextModel | null = null;
  let language: Extension = [];
  let unbind: (() => void) | null = null;
  let saveState: ((uri: string, state: FileViewState) => void) | null = null;
  let loading = 0;

  const extensions = (): Extension => [
    model ? codeEditorExtensions({ model, language, dark, editable: model.writable }) : [codeTheme(dark), EditorState.readOnly.of(true)],
    highlightActiveLine(), readingLayout,
  ];
  const state = (doc: string | TextModel['doc'], selection?: EditorSelection) =>
    EditorState.create({ doc, selection, extensions: config.of(extensions()) });
  const view = new EditorView({ parent: container, state: state('') });
  const reconfigure = () => view.dispatch({ effects: config.reconfigure(extensions()) });

  const snapshot = (): FileViewState => ({
    ranges: view.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
    mainIndex: view.state.selection.mainIndex,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  });

  return {
    container,
    view,
    get model() { return model; },
    attach(next, saved, save) {
      if (next === model) return;
      if (model) saveState?.(model.uri, snapshot());
      unbind?.();
      unbind = null;
      saveState = save;
      model = next;
      language = [];
      const length = next?.doc.length ?? 0;
      const selection = saved
        ? EditorSelection.create(saved.ranges.map(r => EditorSelection.range(Math.min(r.anchor, length), Math.min(r.head, length))), saved.mainIndex)
        : undefined;
      view.setState(state(next?.doc ?? '', selection));
      if (!next) return;
      unbind = bindModel(view, next);
      if (saved) view.requestMeasure({ read: () => null, write: () => {
        view.scrollDOM.scrollTop = saved.scrollTop;
        view.scrollDOM.scrollLeft = saved.scrollLeft;
      } });
      const token = ++loading;
      loadLanguage(next.languageId).then((loaded) => {
        if (token !== loading || model !== next) return;
        language = loaded;
        reconfigure();
      }, (error: unknown) => log.error('[file-editor] syntax highlighting failed to load; showing plain text', { language: next.languageId, error }));
    },
    setDark(next) {
      if (next === dark) return;
      dark = next;
      reconfigure();
    },
    setFontSize(px) {
      view.dom.style.fontSize = `${px}px`;
      // The 13px → 20px line rhythm of the diff editor, kept at every zoom step.
      view.scrollDOM.style.lineHeight = `${Math.round(px * 20 / FILE_EDITOR_FONT_SIZE)}px`;
      view.requestMeasure();
    },
    destroy() {
      if (model) saveState?.(model.uri, snapshot());
      unbind?.();
      view.destroy();
      container.remove();
    },
  };
}

/** The context menu's editing commands, on the editor's own selection and the file's history. */
export async function runEditAction(view: EditorView, model: TextModel, action: FileViewerEditAction): Promise<void> {
  if (action === 'undo') { model.undo(view); return; }
  if (action === 'redo') { model.redo(view); return; }
  if (action === 'cut') {
    const { state } = view;
    await platform.writeClipboardText(state.selection.ranges.map(r => state.sliceDoc(r.from, r.to)).join(state.lineBreak));
    view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' });
    return;
  }
  const text = await navigator.clipboard.readText();
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
}
