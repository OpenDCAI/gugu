import { Avatar, type AvatarProps } from '../Avatar'
import { IdentityPlaceholder } from '../IdentityPlaceholder'

export function MessageSenderAvatar({ senderUserId, ...props }: AvatarProps & { senderUserId: string | null }) {
  return senderUserId === null ? <IdentityPlaceholder size={32} /> : <Avatar {...props} />
}
