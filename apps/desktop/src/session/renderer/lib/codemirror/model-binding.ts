import { ChangeSet, Transaction, type TransactionSpec, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type * as Monaco from 'monaco-editor';
import { modelPosition } from './model-position';

export function modelChanges(doc: Text, event: Monaco.editor.IModelContentChangedEvent): ChangeSet {
  return ChangeSet.of(event.changes.map(({ range, text }) => ({
    from: modelPosition(doc, { lineNumber: range.startLineNumber, column: range.startColumn }),
    to: modelPosition(doc, { lineNumber: range.endLineNumber, column: range.endColumn }),
    insert: text,
  })), doc.length);
}

/** User edits enter the model; only model events enter the CM document, including the initiating view. */
export function bindModel(view: EditorView, model: Monaco.editor.ITextModel, monaco: typeof Monaco) {
  // @@@ dispatch-wrap: user transactions must become model edits before CM applies them, so that
  // every CM document change (including the initiating view's) arrives from the model event alone.
  // That needs a hook in front of the view's update. EditorView's official hook is the
  // `dispatchTransactions` config, but @codemirror/merge (6.12.3) builds both MergeView sides
  // itself and installs its own `dispatchTransactions` (chunk bookkeeping) without exposing one
  // per side; transaction/change filters run inside `state.update`, where a model edit re-enters
  // and the outer transaction no longer starts from the view's state. So both modes wrap
  // `view.dispatch`. Switch to `dispatchTransactions` once MergeView accepts it per side.
  const apply = view.dispatch.bind(view);
  let lastEdit: { version: number; time: number; event: string | undefined } | undefined;
  const selections = (doc: Text, selection: typeof view.state.selection) => selection.ranges.map(({ anchor, head }) => {
    const start = modelPosition(doc, anchor);
    const end = modelPosition(doc, head);
    return new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column);
  });
  const listener = model.onDidChangeContent(event => {
    apply({ changes: modelChanges(view.state.doc, event) });
  });

  view.dispatch = (...input: (Transaction | readonly Transaction[] | TransactionSpec)[]) => {
    const transactions = input.length === 1 && input[0] instanceof Transaction
      ? [input[0]]
      : input.length === 1 && Array.isArray(input[0])
        ? input[0] as readonly Transaction[]
        : [view.state.update(...input as TransactionSpec[])];
    if (!transactions.some(transaction => transaction.docChanged)) {
      apply(transactions);
      return;
    }
    if (view.state.readOnly) return;
    const first = transactions[0]!;
    const last = transactions[transactions.length - 1]!;
    const changes = transactions.reduce((all, transaction) => all.compose(transaction.changes), ChangeSet.empty(first.startState.doc.length));
    const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = [];
    changes.iterChanges((from, to, _fromB, _toB, insert) => {
      const start = modelPosition(first.startState.doc, from);
      const end = modelPosition(first.startState.doc, to);
      edits.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: insert.toString() });
    });
    const time = Date.now();
    const event = last.annotation(Transaction.userEvent);
    if (!lastEdit || lastEdit.version !== model.getVersionId() || event !== 'input.type' || lastEdit.event !== event || time - lastEdit.time > 500) {
      model.pushStackElement();
    }
    model.pushEditOperations(selections(first.startState.doc, first.startState.selection), edits, () => selections(last.newDoc, last.newSelection));
    lastEdit = { version: model.getVersionId(), time, event };
    // Document changes have already arrived through the model subscription.
    apply({
      selection: last.newSelection, effects: last.effects,
      annotations: event ? Transaction.userEvent.of(event) : [],
      scrollIntoView: last.scrollIntoView,
    });
  };

  return () => {
    model.pushStackElement();
    listener.dispose();
    view.dispatch = apply;
  };
}
