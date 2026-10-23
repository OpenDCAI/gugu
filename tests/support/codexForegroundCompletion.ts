/**
 * These adapter regression tests assert foreground outcomes. ACP v2 receipts and idle
 * are separate wire facts: join them by the echoed native message ID for this observer.
 * SDK conformance tests consume the unmodified wire and assert early receipts separately.
 */
export function observeCodexForegroundCompletion(onLine: (line: string) => void): (line: string) => void {
  const inserted = new Set<string>();
  const completed = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, { id: unknown }>();
  const flush = () => {
    for (const [messageId, receipt] of receipts) {
      const outcome = completed.get(messageId);
      if (!outcome) continue;
      receipts.delete(messageId);
      const { stopReason, error, _meta } = outcome;
      onLine(JSON.stringify(stopReason === 'error'
        ? { jsonrpc: '2.0', id: receipt.id, error }
        : { jsonrpc: '2.0', id: receipt.id, result: { stopReason, ...(_meta ? { _meta } : {}) } }));
    }
  };
  return line => {
    const message = JSON.parse(line);
    const update = message.method === 'session/update' ? message.params?.update : null;
    if (update?.sessionUpdate === 'user_message') inserted.add(update.messageId);
    if (update?.sessionUpdate === 'state_update' && update.state === 'idle' && update.stopReason) {
      for (const messageId of inserted) completed.set(messageId, update);
      inserted.clear();
    }
    if (typeof message.result?.messageId === 'string') {
      receipts.set(message.result.messageId, message);
      flush();
      return;
    }
    onLine(line);
    flush();
  };
}
