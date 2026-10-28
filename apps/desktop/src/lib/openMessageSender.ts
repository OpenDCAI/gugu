import type { MessageSenderTarget } from '@gugu/session-chat-ui'
import { followLink, openLinkTarget } from './guguLinks'
import { notify } from './notices'

/** The existing shell opens groups/messages, sessions and private peers. */
export function openMessageSender(target: MessageSenderTarget): void {
  if (target.kind !== 'sender') { followLink(target); return }
  void openLinkTarget(target).catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
}
