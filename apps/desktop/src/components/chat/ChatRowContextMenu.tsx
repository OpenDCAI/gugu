import type { ComponentProps } from 'react'
import { PersonalConversationRowMenu } from './PersonalConversationRowMenu'

/** Both desktop context click and phone long press use the same personal list operation. */
export function ChatRowContextMenu(props: ComponentProps<typeof PersonalConversationRowMenu>) {
  return <PersonalConversationRowMenu {...props} />
}
