const failure = message => Object.assign(new Error(message), { code: 'queue_update_failed' })

/** Mutate only the verified session's pending jobs; creation times and request identities stay intact. */
export async function changePhoneConversationQueue({ store, agent, action, interrupt, publish }) {
  const queued = Object.values(store.state.jobs).filter(job => job.agentUserId === agent.agentUserId && job.status === 'queued' && (!job.contextEpoch || job.contextEpoch === agent.contextEpoch))
  if (!action || typeof action !== 'object' || !['edit','delete','reorder','send-now'].includes(action.kind)) throw failure('请指定队列操作')
  const reorder = ids => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || ids.length !== queued.length || new Set(ids).size !== queued.length || ids.some(id => !queued.some(job => job.id === id))) throw failure('队列已变化，请重新读取后排序')
    const slots = new Set(queued.map(job => job.id)), byId = new Map(queued.map(job => [job.id, job]))
    let index = 0
    store.state.jobs = Object.fromEntries(Object.entries(store.state.jobs).map(([id, job]) => slots.has(id) ? [ids[index], byId.get(ids[index++])] : [id, job]))
  }
  if (action.kind === 'reorder') reorder(action.ids)
  else {
    const job = queued.find(job => job.id === action.id)
    if (!job) throw failure('这条消息已不在队列中')
    if (action.kind === 'edit') {
      if (typeof action.text !== 'string' || !action.text.trim()) throw failure('排队消息不能为空')
      if (action.queueEdit && (typeof action.queueEdit.draftText !== 'string' || typeof action.queueEdit.originalDraftText !== 'string')) throw failure('排队编辑状态无效')
      job.prompt = action.text
      if (action.queueEdit) job.queueEdit = action.queueEdit
      else delete job.queueEdit
    } else if (action.kind === 'delete') {
      job.status = 'cancelled'; job.finishedAt = new Date().toISOString()
    } else if (action.kind === 'send-now') {
      if (action.steers) throw failure('手机 Agent 当前不支持回合内插入')
      if (job.queueEdit) throw failure('请先完成这条排队消息的编辑')
      reorder([job.id, ...queued.filter(other => other.id !== job.id).map(other => other.id)])
      await interrupt?.(agent)
    } else throw failure('不支持这个队列操作')
  }
  await store.save()
  publish()
  return null
}
