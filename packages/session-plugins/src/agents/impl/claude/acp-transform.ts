import { decodeV2SessionUpdate, type NormalizedEvent, type SessionUsage } from '@gugu/session-core/acp';

/** Each connection retains the tool names its own producer actually reported. */
export function createClaudeSessionDecoder(): (raw: unknown) => NormalizedEvent {
  const toolNames = new Map<string, string>();
  return (raw: unknown): NormalizedEvent => {
    const event = decodeV2SessionUpdate(raw);
    const meta = (raw as { _meta?: Record<string, unknown> })._meta;
    if (event.kind === 'usage') {
      const limit = meta?.['_claude/rateLimit'] as Record<string, unknown> | undefined;
      const status = limit?.status;
      const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
      const resetsAt = number(limit?.resetsAt);
      const rateLimit: SessionUsage['rateLimit'] = status === 'allowed' || status === 'allowed_warning' || status === 'rejected'
        ? { status, resetsAt: resetsAt === null ? null : resetsAt * 1000,
            window: typeof limit?.rateLimitType === 'string' ? limit.rateLimitType : null,
            utilization: number(limit?.utilization) }
        : null;
      return { ...event, usage: { ...event.usage,
        ...(meta?.['_claude/contextWindowEstimated'] === true ? { contextSize: 0 } : {}),
        ...(rateLimit ? { rateLimit } : {}) } };
    }
    if (event.kind === 'tool_call' || event.kind === 'tool_update') {
      const claude = meta?.claudeCode as {
        parentToolUseId?: unknown;
        toolName?: unknown;
        toolResponse?: { agentId?: unknown; isAsync?: unknown; description?: unknown;
          outputFile?: unknown; resolvedModel?: unknown };
      } | undefined;
      const parentToolCallId = typeof claude?.parentToolUseId === 'string'
        ? claude.parentToolUseId : event.parentToolCallId ?? null;
      if (event.kind === 'tool_call' && typeof event.toolName === 'string') toolNames.set(event.toolCallId, event.toolName);
      const name = event.toolName ?? toolNames.get(event.toolCallId) ?? claude?.toolName;
      const result = claude?.toolResponse;
      if (name === 'Agent' || name === 'Task') {
        // The standard child update names its session; only the native Agent result identifies
        // the launching tool call. This is lineage/model metadata, not a second child lifecycle.
        const input = (raw as { rawInput?: { description?: unknown; model?: unknown } }).rawInput;
        const title = typeof result?.description === 'string' ? result.description
          : event.title && event.title !== 'Agent' && event.title !== 'Task' ? event.title : undefined;
        return { kind: 'subagent', toolCallId: event.toolCallId, status: event.status ?? null, parentToolCallId,
          ...(title !== undefined ? { title } : {}),
          ...(typeof input?.description === 'string' ? { inputSummary: input.description } : {}),
          ...(event.rawInput != null ? { rawInput: event.rawInput } : {}),
          ...(event.rawOutput != null ? { rawOutput: event.rawOutput } : {}),
          ...(event.outputText != null ? { outputText: event.outputText } : {}),
          ...(typeof result?.agentId === 'string' ? { agentId: result.agentId } : {}),
          ...(result?.isAsync === true ? { background: true } : {}),
          ...(typeof result?.outputFile === 'string' ? { outputFile: result.outputFile } : {}),
          ...(typeof result?.resolvedModel === 'string' ? { model: result.resolvedModel }
            : typeof input?.model === 'string' ? { model: input.model } : {}),
        };
      }
      if (parentToolCallId !== event.parentToolCallId) return { ...event, parentToolCallId };
    }
    return event;
  };
}
