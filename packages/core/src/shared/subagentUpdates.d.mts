export const DRAFT_UPDATE_META_KEY: 'gugu.draftSessionUpdate';
export function subagentUpdate(update: { sessionUpdate: string; subagentSessionId: string; [key: string]: unknown }): {
  sessionUpdate: 'tool_call_update'; toolCallId: string; _meta: Record<string, unknown>;
};
