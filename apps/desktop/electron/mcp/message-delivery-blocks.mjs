/** Read the immutable recipient result, never infer it from current presence. */
export async function messageDeliveryBlocks(deps, messageId) {
  const rows = await deps.restGet(`message_agent_delivery_blocks?message_id=eq.${encodeURIComponent(messageId)}&select=agent_user_id,reason`, 'chat')
  if (!Array.isArray(rows)) throw new Error('Message delivery refusal result is unavailable')
  return rows.map((row) => {
    if (typeof row.agent_user_id !== 'string' || row.reason !== 'agent_archived') throw new Error('Invalid message delivery refusal result')
    return { agent_user_id: row.agent_user_id, reason: row.reason }
  })
}

export async function archivedDeliveryReceipt(deps, messageId) {
  const blocks = await messageDeliveryBlocks(deps, messageId)
  return blocks.length ? `; 对方已归档、未送达 (${blocks.map((row) => `user:${row.agent_user_id}`).join(', ')}; agent_archived; retained in history, no replay after restoration)` : ''
}
