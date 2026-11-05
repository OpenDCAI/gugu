import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction, type ChangeSet, type ChangeSpec, type Text } from '@codemirror/state';

export interface TextModelChange {
  /** Relative to the document before the change. */
  changes: ChangeSet;
  /** Only for undo/redo: the selection the history restores, meant for `origin`. */
  selection?: EditorSelection;
  /** Who asked for the change (a bound view), so it alone takes `selection`. */
  origin?: unknown;
}

/** The file's line ending, by majority: lines are kept apart in the document and written back with it. */
function lineEnding(text: string): '\n' | '\r\n' {
  const crlf = text.split('\r\n').length - 1;
  return crlf > text.split('\n').length - 1 - crlf ? '\r\n' : '\n';
}

/**
 * One file's text with its undo history — the document every editor view of that file mirrors.
 *
 * A file can be shown in several views at once (the file editor and the review diff), and undo belongs to the file, not
 * to whichever view happened to type: so the text and the history live here, in a CodeMirror state no view owns, and
 * views only forward their edits in and apply the changes that come out (see `bindModel`).
 */
export class TextModel {
  private state: EditorState;
  private eol: '\n' | '\r\n';
  private readonly listeners = new Set<(change: TextModelChange) => void>();

  constructor(readonly uri: string, readonly languageId: string, text: string) {
    this.state = TextModel.fresh(text);
    this.eol = lineEnding(text);
  }

  private static fresh(text: string): EditorState {
    return EditorState.create({ doc: text, extensions: [history(), EditorState.allowMultipleSelections.of(true)] });
  }

  /** Buffers (file://) are the edited copies; disk:// and git:// snapshots are read-only. */
  get writable(): boolean {
    return this.uri.startsWith('file://');
  }

  get doc(): Text {
    return this.state.doc;
  }

  /** The file's text, with its own line endings (what saving writes). */
  getValue(): string {
    return this.state.doc.sliceString(0, this.state.doc.length, this.eol);
  }

  onDidChange(listener: (change: TextModelChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: TextModelChange): void {
    if (change.changes.empty) return;
    for (const listener of [...this.listeners]) listener(change);
  }

  private commit(transaction: Transaction, change: Omit<TextModelChange, 'changes'> = {}): void {
    this.state = transaction.state;
    this.emit({ changes: transaction.changes, ...change });
  }

  /** Replace the whole text and forget the history (a fresh read, not an edit). */
  setValue(text: string): void {
    if (this.getValue() === text) return;
    const changes = this.state.changes({ from: 0, to: this.state.doc.length, insert: text });
    this.state = TextModel.fresh(text);
    this.eol = lineEnding(text);
    this.emit({ changes });
  }

  /**
   * Apply an edit. `selectionBefore` / `selection` are the editing view's selections, so undo puts the cursor back
   * where it was; `userEvent` lets the history group typing the way CodeMirror does.
   */
  edit(changes: ChangeSpec, options: {
    selectionBefore?: EditorSelection;
    selection?: EditorSelection;
    userEvent?: string;
    addToHistory?: boolean;
    origin?: unknown;
  } = {}): void {
    let state = this.state;
    if (options.selectionBefore) {
      state = state.update({ selection: options.selectionBefore, annotations: Transaction.addToHistory.of(false) }).state;
    }
    const annotations = [
      ...(options.userEvent ? [Transaction.userEvent.of(options.userEvent)] : []),
      ...(options.addToHistory === false ? [Transaction.addToHistory.of(false)] : []),
    ];
    this.commit(state.update({ changes, selection: options.selection, annotations }), { origin: options.origin });
  }

  undo(origin?: unknown): boolean {
    return this.step(undo, origin);
  }

  redo(origin?: unknown): boolean {
    return this.step(redo, origin);
  }

  private step(command: typeof undo, origin: unknown): boolean {
    let transaction: Transaction | undefined;
    command({ state: this.state, dispatch: (next) => { transaction = next; } });
    if (!transaction) return false;
    this.commit(transaction, { selection: transaction.selection, origin });
    return true;
  }

  get canUndo(): boolean {
    return undoDepth(this.state) > 0;
  }

  get canRedo(): boolean {
    return redoDepth(this.state) > 0;
  }
}
