type ProjectNoticeDeps = {
  agentUserId: () => Promise<string | null>
  ensureAccess: (agentUserId: string, project: { projectId: string; projectName: string; chatId: string }) => Promise<void>
}

/** Run on the calling device after either a local or remote project action. A failed announcement
 * must not disguise an already committed folder/device change as a failed mutation. */
export async function prepareProjectAgentNotice(result: unknown, deps: ProjectNoticeDeps): Promise<unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const row = result as Record<string, unknown>
  const notice = row.group_notice && typeof row.group_notice === 'object' ? row.group_notice as Record<string, unknown> : null
  const chatId = notice?.chat_id ?? row.chat_id
  if (typeof chatId !== 'string') return result
  try {
    const agent = await deps.agentUserId()
    if (!agent) throw new Error('当前 agent 的咕咕身份尚未就绪')
    await deps.ensureAccess(agent, { chatId, projectId: String(row.project_id), projectName: String(row.name ?? '项目') })
    return {
      ...row,
      group_access: { chat_id: chatId, status: 'ready' },
      ...(notice ? { group_notice: { ...notice, status: 'ready', next: 'Read this group’s rules, then post this change with message_send as yourself. Offer the owner undo only when an undo action is returned.' } } : {}),
    }
  } catch (error) {
    const unavailable = { chat_id: chatId, status: 'unavailable', error: error instanceof Error ? error.message : String(error), next: 'The project operation succeeded, but group access is unavailable. Tell the owner; retry access with project_get before posting. Do not repeat the mutation.' }
    return { ...row, group_access: unavailable, ...(notice ? { group_notice: { ...notice, ...unavailable } } : {}) }
  }
}
