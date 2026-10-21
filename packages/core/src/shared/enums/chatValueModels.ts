import type { ChatKind, GroupMemberType, MessageContentType, MessageDeliveryStatus } from '../types/chat'

export const CHAT_KINDS: ChatKind[] = ['dm', 'group', 'ai']
export const MESSAGE_CONTENT_TYPES: MessageContentType[] = ['text', 'card', 'system', 'attachment', 'widget']
export const MESSAGE_DELIVERY_STATUSES: MessageDeliveryStatus[] = ['delivered', 'read']
export const GROUP_MEMBER_TYPES: GroupMemberType[] = ['human', 'agent']
