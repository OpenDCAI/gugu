import { AssistantPanelError, type AssistantPanelNotice, type AssistantPanelReceipt } from './assistantPanel'

type Entry = { notice: AssistantPanelNotice; assistantId?: string }
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }
const storageKey = (owner: string) => `gugu.assistant-panel.notices.v1:${owner}`

/** Only safe change summaries belong here. The source edit has already saved;
 * publication retries are a system responsibility, independent of any device. */
export function createAssistantPanelOutbox(deps: {
  storage: Storage; accountId(): string | null
  assistantId(owner: string): Promise<string | null>
  send(assistantId: string, notice: AssistantPanelNotice): Promise<AssistantPanelReceipt>
}) {
  const flushing = new Map<string, Promise<AssistantPanelReceipt | null>>()
  const assertOwner = (owner: string) => {
    if (deps.accountId() !== owner) throw new AssistantPanelError('account-changed','Assistant panel account changed')
  }
  function read(owner: string): Entry[] {
    const raw = deps.storage.getItem(storageKey(owner))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some(entry => !entry || typeof entry !== 'object'
      || !entry.notice || typeof entry.notice.operationId !== 'string')) {
      throw new AssistantPanelError('invalid-outbox','Saved App changes could not be read')
    }
    return parsed
  }
  function save(owner: string, entries: Entry[]) {
    assertOwner(owner)
    deps.storage.setItem(storageKey(owner),JSON.stringify(entries))
  }
  async function drain(owner: string): Promise<AssistantPanelReceipt | null> {
    let receipt: AssistantPanelReceipt | null = null
    for (;;) {
      assertOwner(owner)
      const entry = read(owner)[0]
      if (!entry) return receipt
      const assistant = entry.assistantId ?? await deps.assistantId(owner)
      assertOwner(owner)
      if (!assistant) {
        // No assistant to tell. The edits themselves are already saved in their own tables, and an assistant opened later
        // reads that current state, so these change notices have no one to inform: drop them (never wait and re-poll).
        save(owner,read(owner).filter(next => next.assistantId))
        continue
      }
      try { receipt = await deps.send(assistant,entry.notice) }
      catch (error) {
        if (!['22023','23505','54000','55000','42501'].includes(String((error as { code?: string }).code))) throw error
        // Metadata is informational. An invalid notice must not trap all later
        // notices in an endless retry cycle after their source edits saved.
      }
      assertOwner(owner)
      // Read again after the network operation: an intervening enqueue must stay.
      save(owner,read(owner).filter(next => next.notice.operationId !== entry.notice.operationId))
    }
  }
  function flush(owner: string): Promise<AssistantPanelReceipt | null> {
    const active = flushing.get(owner)
    if (active) return active
    const request = drain(owner).finally(() => { if (flushing.get(owner) === request) flushing.delete(owner) })
    flushing.set(owner,request)
    return request
  }
  return {
    hasPending: (owner: string) => { assertOwner(owner); return read(owner).length > 0 },
    flush,
    enqueue(owner: string, notice: AssistantPanelNotice, assistantId?: string) {
      assertOwner(owner)
      const entries = read(owner)
      const existing = entries.find(entry => entry.notice.operationId === notice.operationId)
      if (existing && JSON.stringify(existing) !== JSON.stringify({ notice,...(assistantId ? { assistantId } : {}) })) {
        throw new AssistantPanelError('operation-conflict','App change operation ID has different content')
      }
      if (!existing) save(owner,[...entries,{ notice,...(assistantId ? { assistantId } : {}) }])
      return flush(owner)
    },
  }
}
