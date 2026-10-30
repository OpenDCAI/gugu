import * as autocomplete from '@codemirror/autocomplete';
import * as commands from '@codemirror/commands';
import * as langJson from '@codemirror/lang-json';
import * as langMarkdown from '@codemirror/lang-markdown';
import * as language from '@codemirror/language';
import * as lint from '@codemirror/lint';
import * as search from '@codemirror/search';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as lezerCommon from '@lezer/common';
import * as lezerHighlight from '@lezer/highlight';
import * as lezerMarkdown from '@lezer/markdown';
import { basicSetup, minimalSetup } from 'codemirror';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { CONTENT_MENU_EVENT, type ContentMenuRequest } from '@gugu/session-shared/content-menu';
import * as Y from 'yjs';
import { guguError } from './host';
import { imeHold, keepCaretAboveKeyboard, sameLineHold } from './ime-hold';
import { internals } from './open-file';

/**
 * `/_gugu/<ver>/codemirror.js` — the platform's pinned CodeMirror 6, and the one-line binding.
 *
 * Shipped by the platform rather than bundled by the App: two copies of `@codemirror/state`
 * cannot live in one editor (an extension from one is "unrecognized" by the other), and an
 * App without a build step could not import CodeMirror at all under `script-src 'self'`.
 *
 * The binding is a convenience over the general text API (insert / delete / delta /
 * anchors); ProseMirror, a textarea or anything else binds through that instead.
 */

const { EditorView, keymap } = cmView;
const { Compartment, EditorState, Prec, StateEffect } = cmState;
type Extension = cmState.Extension;
const { markdown, markdownLanguage } = langMarkdown;
const { json } = langJson;

/**
 * `markdownLanguage` is GFM (tables, strikethrough, task lists): `markdown({ base: markdownLanguage })`, or its parser for a
 * preview. 摩擦单 F25: the modules themselves too, whole — `view` (Decoration, ViewPlugin, MatchDecorator …), `state`,
 * `language`, `commands`, `search`, `autocomplete`, `lint`, `langMarkdown`, `langJson`, `lezerCommon`, `lezerHighlight`,
 * `lezerMarkdown` — the very copies the binding uses, so an App's own plugin or decoration works on a bound editor
 * (a second copy of @codemirror/state would not: its facets and fields are not this one's).
 */
export const codemirror = Object.freeze({
  EditorView,
  EditorState,
  basicSetup,
  minimalSetup,
  keymap,
  markdown,
  markdownLanguage,
  json,
  view: cmView,
  state: cmState,
  language,
  commands,
  search,
  autocomplete,
  lint,
  langMarkdown,
  langJson,
  lezerCommon,
  lezerHighlight,
  lezerMarkdown,
});

/** What pasting a picture needs of `gugu` (create-gugu.ts hands its own): the page's upload, and its error report. */
export type PictureVerbs = { upload(place: unknown, files: File[]): Promise<unknown>; reportError(message: string): Promise<unknown> };

/** Pictures only, and no text with them (a copied page's text pastes as text): the files a paste or a drop carries. */
function picturesIn(data: DataTransfer | null): File[] {
  const files = [...(data?.files ?? [])];
  return files.length > 0 && files.every((f) => f.type.startsWith('image/')) && !data!.types.includes('text/plain') ? files : [];
}

/**
 * A picture pasted or dropped into a chat file's editor is saved first, a file in the document's folder (`files.upload`,
 * the folder's one way in), then named where it was put: `![name](gugu-file://<id>)`, which `gugu.markdown()` draws.
 * The place is carried through what is typed while it uploads. A working copy's file keeps the editor's own handling.
 */
function pictureDrops(view: cmView.EditorView, file: { entry?: { chat?: unknown; path?: unknown } }, verbs: PictureVerbs): Extension {
  const waiting = new Set<{ at: number }>();
  const put = (event: Event, files: File[], at: number) => {
    // Where the file is now (it may have moved since it was bound).
    const { chat, path } = file.entry ?? {};
    if (files.length === 0 || view.state.readOnly || typeof chat !== 'string') return false;
    const folder = typeof path === 'string' ? path.slice(0, Math.max(path.lastIndexOf('/'), 0)) : '';
    event.preventDefault();
    const place = { at };
    waiting.add(place);
    verbs
      .upload(folder ? { chat, folder } : { chat }, files)
      .then((entries) => {
        const named = (entries as { id: string; name: string }[]).map((e) => `![${e.name.replace(/[[\]\\]/g, '\\$&')}](gugu-file://${e.id})`);
        if (named.length > 0) view.dispatch({ changes: { from: place.at, insert: named.join('\n') } });
      })
      .catch((error: unknown) => verbs.reportError(error instanceof Error ? error.message : String(error)))
      .finally(() => waiting.delete(place));
    return true;
  };
  return [
    EditorView.updateListener.of((update) => {
      for (const place of waiting) place.at = update.changes.mapPos(place.at);
    }),
    EditorView.domEventHandlers({
      paste: (event, v) => put(event, picturesIn(event.clipboardData), v.state.selection.main.head),
      drop: (event, v) => put(event, picturesIn(event.dataTransfer), v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head),
    }),
  ];
}

export function bindCodemirror(view: unknown, file: unknown, verbs?: PictureVerbs): () => void {
  if (!(view instanceof EditorView)) {
    throw guguError('invalid', 'Create the editor with the EditorView from gugu.codemirror(); another copy of CodeMirror cannot be bound');
  }
  const openFile = file && typeof file === 'object' ? internals.get(file) : undefined;
  if (!openFile || openFile.type !== 'text') throw guguError('invalid', 'bind.codemirror takes a text file from gugu.files.open(…), or f.textAt(path)');
  const inner = openFile.internalsForBinding();
  const compartment = new Compartment();
  // Every App's editor gets these two mobile fixes by binding (真源 §4).
  const hold = imeHold(view, () => inner.holdRemote(), { keyboardSession: inner.keyboardSession });
  const stopCaretWatch = keepCaretAboveKeyboard(view);
  let undoManager: Y.UndoManager;

  /**
   * Make the editor show exactly the replica, then attach the collaboration extension.
   * The content swap happens while the compartment is empty, so it is not echoed back into
   * the (possibly stale) replica.
   */
  const extensionFor = (): Extension => {
    const text = inner.text;
    if (view.state.doc.toString() !== text.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text.toString() } });
    }
    undoManager = new Y.UndoManager(text);
    return [
      yCollab(text, inner.awareness, { undoManager }),
      // Undo only undoes this person's typing; ahead of any history() the App's setup brought.
      Prec.highest(keymap.of(yUndoManagerKeymap)),
      EditorState.readOnly.of(inner.readOnly),
      hold.extension,
      verbs ? pictureDrops(view, file as { entry?: { chat?: unknown; path?: unknown } }, verbs) : [],
    ];
  };

  view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(extensionFor())) });
  const menu = (event: Event) => {
    const detail = (event as CustomEvent<ContentMenuRequest>).detail;
    if (detail.action === 'snapshot') detail.editorHistory = { undo: !view.state.readOnly && undoManager.undoStack.length > 0, redo: !view.state.readOnly && undoManager.redoStack.length > 0 };
    else if (!view.state.readOnly && yUndoManagerKeymap.find(binding => binding.key === (detail.action === 'undo' ? 'Mod-z' : 'Mod-y'))?.run?.(view)) event.preventDefault();
  };
  view.contentDOM.addEventListener(CONTENT_MENU_EVENT, menu);
  const sameLine = () => sameLineHold(view, inner.text, (inspector) => inner.inspectRemote(inspector), hold);
  let stopSameLine = sameLine();
  // The file moved to a new epoch: a new replica, so a new binding on it.
  const offSwap = inner.onSwap(() => {
    hold.swapped();
    stopSameLine();
    view.dispatch({ effects: compartment.reconfigure([]) });
    view.dispatch({ effects: compartment.reconfigure(extensionFor()) });
    stopSameLine = sameLine();
  });
  return () => {
    view.contentDOM.removeEventListener(CONTENT_MENU_EVENT, menu);
    offSwap();
    stopSameLine();
    stopCaretWatch();
    hold.destroy();
    view.dispatch({ effects: compartment.reconfigure([]) });
  };
}
