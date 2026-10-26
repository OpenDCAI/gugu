import type { AssistantPanelDomain,AssistantPanelItem,AssistantPanelSnapshot } from './assistantPanel'

/** Synchronous, account-bound local copies. The shell supplies persistence; the
 * cloud remains authoritative and ordinary reads still reconcile its state. */
export interface AssistantPanelReadCache {
  peekSnapshot(): AssistantPanelSnapshot | undefined
  saveSnapshot(snapshot: AssistantPanelSnapshot): void
  peekBody(item: AssistantPanelItem): Uint8Array | undefined
  saveBody(item: AssistantPanelItem,bytes: Uint8Array): void
  forget(domain: AssistantPanelDomain,key: string,revision: string): void
}
