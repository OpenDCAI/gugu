import { useChatFolderName } from '../chat/chatFolderName'
import { GroupAppSlot, WORKSPACE_APP_KIND, type GroupAppSlotProps } from './GroupAppSlot'

/** A chat's folder (the preinstalled workspace App) in its side panel, titled 群文件夹 / 文件夹 by the chat it is in. */
export function GroupFolderSlot(props: Omit<GroupAppSlotProps, 'kind' | 'title'>) {
  const title = useChatFolderName(props.chatId)
  return <GroupAppSlot {...props} kind={WORKSPACE_APP_KIND} title={title} />
}
