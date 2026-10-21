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
  const liveOutput = item.terminalId ? ctx.terminalOutputText(item.terminalId) : null;
  const outputText = liveOutput ?? item.outputText;
  // Two sources, and they are not equivalent. The client-owned terminal is the
  // first-hand one — we spawned that process — but it only exists when the agent
  // took ACP's `terminal/create` route, which neither shipped adapter does. Both
  // of those instead report the exit themselves, and their provider hook promotes
  // it onto the item. Prefer the reading we took ourselves; fall back to the one
  // we were told.
  const liveExit = item.terminalId ? ctx.terminalExitStatus(item.terminalId) : null;
  const exitStatus = liveExit ?? item.exitStatus ?? null;
  return {
    kind: 'execute',
    id: item.id,
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
