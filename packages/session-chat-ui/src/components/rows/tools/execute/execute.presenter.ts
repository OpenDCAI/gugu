import type { SegmentCtx } from '@session-chat/core/units';
import type { ChatExecute, ToolNode } from '@session-chat/model';

function isStructuredRawOutput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

export function executeFromItem(
  item: Extract<ToolNode, { kind: 'execute-tool-call' }>,
  ctx: SegmentCtx
): ChatExecute {
  const terminal = item.terminalId ? ctx.terminalSnapshot(item.terminalId) : null;
  const outputText = terminal ? (terminal.truncated
    ? `${ctx.translate('transcript.terminalTruncated')}\n${terminal.output}` : terminal.output) : item.outputText;
  const exitStatus = terminal?.exitStatus ?? item.exitStatus ?? null;
  return {
    kind: 'execute',
    id: item.id,
    ...(item.trimmedChars ? { transportNote: ctx.translate('transcript.outputTrimmed', { chars: item.trimmedChars }) } : {}),
    command: item.command ?? item.title,
    ...(item.inputSummary !== undefined ? { inputSummary: item.inputSummary } : {}),
    ...(outputText !== undefined ? { outputText } : {}),
    // `rawInput` is the adapter envelope (`{command, description, ...}`), not
    // another reading of the command. The command chip/body already shows the
    // human-facing value; putting the envelope under it made expanded rows
    // print machine JSON in the transcript. Keep structured adapter metadata
    // out of the default disclosure as well when terminal output is present.
    // A raw output is retained only when it is the sole result, so providers
    // that have no terminal output do not lose their only user-facing text.
    ...(outputText === undefined &&
    item.rawOutput !== undefined &&
    !isStructuredRawOutput(item.rawOutput)
      ? { result: item.rawOutput }
      : {}),
    status: item.status,
    awaitingPermission: ctx.pendingToolCallIds().has(item.toolCallId),
    startedAt: 0,
    ...(item.terminalId !== undefined ? { terminalId: item.terminalId } : {}),
    ...(exitStatus !== null ? { exitStatus } : {}),
  };
}
