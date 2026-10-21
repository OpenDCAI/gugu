// Private transport envelope for the shared session model; this does not change the native provider protocol.
export const DRAFT_UPDATE_META_KEY = 'gugu.draftSessionUpdate'

export function subagentUpdate(update) {
  if (!update.subagentSessionId) throw new Error('subagent update requires a session identity')
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: update.subagentSessionId,
    _meta: { [DRAFT_UPDATE_META_KEY]: update },
  }
}
