import { classifyFileLink, type FileLinkClassification } from '@gugu/core/shared/ui/fileLink'

export type SessionChatLinkClassification = FileLinkClassification | { kind: 'conversation'; href: string }

export function classifySessionChatLink(href: string): SessionChatLinkClassification {
  return /^gugu-chat:/i.test(href.trim()) ? { kind: 'conversation', href } : classifyFileLink(href)
}
