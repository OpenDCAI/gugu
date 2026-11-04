import * as Y from 'yjs';
import { applyFromSnapshot } from './apply-from';
import { guguError } from './host';
import { internals, type FieldText, type OpenFile, type StoredTextSnapshot } from './open-file';

/**
 * `gugu.bind.text(view, f)` (摩擦单 F59, L7 S12): a text file on an editor the App draws itself. The rules that keep
 * others' letters are the binding's, not each App's to remember:
 *
 * 1. What it diffs from is always what it last drew (a snapshot taken at every render) — never `f.text`, which may
 *    hold what others typed since.
 * 2. The person's input goes in first, then others' changes come out: an input is committed at once (`applyFrom`), and
 *    a change from elsewhere first flushes what is not committed, then redraws.
 * 3. Never redrawn while the person composes (an input method): others' changes wait for the composition to end.
 * 4. The caret follows the letters: across a redraw it is carried in the file's own coordinates.
 *
 * The view: a `<textarea>` or `<input>` as it is (the common case, one line), or, for a view the App draws itself
 * (contenteditable, WYSIWYG), `{ element, read(), render(text, selection), selection() }`. Its one duty: what it
 * renders it reads back unchanged — `render(t)` then `read() === t` — or it rewrites others' formatting.
 */

export interface TextSelection {
  anchor: number;
  head: number;
}

export interface TextView {
  /** Where the person types: input and composition events are read from it. */
  element: HTMLElement;
  /** The whole text the view shows, serialized the App's way. */
  read(): string;
  /** Show this text, with the caret there when given. */
  render(text: string, selection?: TextSelection): void;
  /** The caret, as offsets in `read()`'s text; null when the view has none (not focused). */
  selection(): TextSelection | null;
}

/** A `<textarea>` / `<input>` as a view: its value is the text, its selection the caret. */
function fieldView(field: HTMLTextAreaElement | HTMLInputElement): TextView {
  return {
    element: field,
    read: () => field.value,
    render: (text, selection) => {
      if (field.value !== text) field.value = text;
      if (selection && field.ownerDocument.activeElement === field) {
        const backward = selection.head < selection.anchor;
        field.setSelectionRange(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), backward ? 'backward' : 'forward');
      }
    },
    selection: () => {
      if (field.ownerDocument.activeElement !== field || field.selectionStart === null || field.selectionEnd === null) return null;
      return field.selectionDirection === 'backward'
        ? { anchor: field.selectionEnd, head: field.selectionStart }
        : { anchor: field.selectionStart, head: field.selectionEnd };
    },
  };
}

function viewOf(target: unknown): TextView {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return fieldView(target);
  const view = target as Partial<TextView> | null;
  if (
    view &&
    typeof view === 'object' &&
    view.element instanceof HTMLElement &&
    typeof view.read === 'function' &&
    typeof view.render === 'function' &&
    typeof view.selection === 'function'
  ) {
    return view as TextView;
  }
  throw guguError('invalid', 'bind.text takes a <textarea> or <input>, or a view { element, read(), render(text, selection), selection() }');
}

interface Drawn {
  doc: Y.Doc;
  text: string;
  snapshot: Y.Snapshot;
}

export function bindText(target: unknown, file: unknown): () => void {
  const view = viewOf(target);
  // A text file, or a JSON file's collaborative text field (`f.textAt(path)`, 摩擦单 F8).
  const openFile: OpenFile | FieldText | StoredTextSnapshot | undefined = file && typeof file === 'object' ? internals.get(file) : undefined;
  if (!openFile || openFile.type !== 'text') throw guguError('invalid', 'bind.text takes a text file from gugu.files.open(…), or f.textAt(path)');
  const handle = file as { readonly readOnly: boolean; readonly status: string; onChange(handler: (event: { local: boolean }) => void): () => boolean };
  if (handle.readOnly && (view.element instanceof HTMLTextAreaElement || view.element instanceof HTMLInputElement)) view.element.readOnly = true;

  const content = () => openFile.content();
  const take = (): Drawn => ({ doc: openFile.doc, text: content().toString(), snapshot: Y.snapshot(openFile.doc) });
  let drawn = take();
  let composing = false;
  /** Others' changes that came in during a composition, drawn once it ends. */
  let waiting = false;
  /** Set while the binding itself writes: its own change is not a change to draw. */
  let writing = false;
  let saidRoundTrip = false;
  let bound = true;

  /** Show the file as it is now, the caret where given; what is shown is the new base. */
  const draw = (selection?: TextSelection) => {
    const text = content().toString();
    view.render(text, selection);
    drawn = take();
    if (!saidRoundTrip && view.read() !== text) {
      saidRoundTrip = true;
      openFile.warn(
        'bind.text: the view gives back other text than it was given (read() after render()) — it must round-trip, or others’ formatting gets rewritten',
      );
    }
  };

  /**
   * What the view shows now, onto the file (from what was drawn); returns the view's caret in the file as it is after.
   * A file that may not be written takes the input back.
   */
  const commit = (): TextSelection | undefined => {
    const next = view.read();
    const selection = view.selection();
    if (drawn.doc !== openFile.doc) {
      // The file was rebuilt (compacted) under the view. The same text: the new copy is the base. Otherwise what was
      // typed meanwhile cannot be placed, and says so.
      if (content().toString() !== drawn.text) {
        openFile.warn('bind.text: an input made while the file was being rebuilt could not be merged; the view shows the file again');
        draw();
        return undefined;
      }
      drawn = take();
    }
    if (next !== drawn.text && (handle.readOnly || handle.status === 'gone')) {
      draw();
      return undefined;
    }
    writing = true;
    try {
      const marks = selection ? [selection.anchor, selection.head] : [];
      const [anchor, head] = applyFromSnapshot(content(), drawn.snapshot, drawn.text, next, marks);
      return selection ? { anchor: anchor!, head: head! } : undefined;
    } finally {
      writing = false;
    }
  };

  /** The person typed: in at once — and if others' changes came in during a composition, drawn now. */
  const typed = () => {
    if (!bound || composing) return;
    const selection = commit();
    if (waiting || content().toString() !== view.read()) {
      waiting = false;
      draw(selection);
    } else {
      drawn = take();
    }
  };

  /** Others changed the file (or the App wrote to it itself): what was typed goes in first, then it is drawn. */
  const changedElsewhere = () => {
    if (!bound || writing) return;
    if (composing) {
      waiting = true;
      return;
    }
    draw(commit());
  };

  const compositionStarted = () => {
    composing = true;
  };
  const compositionEnded = () => {
    composing = false;
    typed();
  };
  const listeners: [string, () => void][] = [
    ['input', typed],
    ['compositionstart', compositionStarted],
    ['compositionend', compositionEnded],
  ];
  for (const [type, listener] of listeners) view.element.addEventListener(type, listener);
  const offChange = handle.onChange(({ local }) => {
    if (!local || !writing) changedElsewhere();
  });
  const offSwap = openFile.onSwap(() => {
    if (!composing) draw(view.selection() ?? undefined);
    else waiting = true;
  });

  if (view.read() !== drawn.text) draw();

  return () => {
    if (!bound) return;
    if (!composing) typed();
    bound = false;
    for (const [type, listener] of listeners) view.element.removeEventListener(type, listener);
    offChange();
    offSwap();
  };
}
