import { ChangeSet, Transaction, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { TextModel } from '@renderer/lib/text-model/text-model';

/** User edits enter the model; only model events enter the CM document, including the initiating view. */
export function bindModel(view: EditorView, model: TextModel) {
  // @@@ dispatch-wrap: user transactions must become model edits before CM applies them, so that
  // every CM document change (including the initiating view's) arrives from the model event alone.
  // That needs a hook in front of the view's update. EditorView's official hook is the
  // `dispatchTransactions` config, but @codemirror/merge (6.12.3) builds both MergeView sides
  // itself and installs its own `dispatchTransactions` (chunk bookkeeping) without exposing one
  // per side; transaction/change filters run inside `state.update`, where a model edit re-enters
  // and the outer transaction no longer starts from the view's state. So both modes wrap
  // `view.dispatch`. Switch to `dispatchTransactions` once MergeView accepts it per side.
  const apply = view.dispatch.bind(view);
  const unsubscribe = model.onDidChange(({ changes, selection, origin }) => {
    // Undo/redo restores the cursor only in the view that asked for it; elsewhere the selection just maps.
    const own = origin === view && selection !== undefined;
    apply({ changes, selection: own ? selection : undefined, scrollIntoView: own });
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
    const event = last.annotation(Transaction.userEvent);
    model.edit(changes, { selectionBefore: first.startState.selection, selection: last.newSelection, userEvent: event, origin: view });
    // Document changes have already arrived through the model subscription.
    apply({
      selection: last.newSelection, effects: last.effects,
      annotations: event ? Transaction.userEvent.of(event) : [],
      scrollIntoView: last.scrollIntoView,
    });
  };

  return () => {
    unsubscribe();
    view.dispatch = apply;
  };
}
