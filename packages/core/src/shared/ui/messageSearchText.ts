import type { MessageItem } from '../types/chat'
import { parseAttachmentContent } from './attachmentModels'
import { parseSystemNotice } from './systemNotice'
import { parseComposerCard } from './taskCardModels'
import { parseVoiceAttachmentContent } from './voiceAttachmentModels'

/** Message-owned text only: no viewer-dependent labels, delivery state or attachment addresses. */
export function projectMessageSearchText(message: MessageItem): string {
  // The search contract excludes every retraction, including legacy system rows rendered before the UI's retraction branch.
  if (message.retracted_at) return ''

  switch (message.content_type) {
    case 'text':
      return message.content ?? ''
    case 'attachment': {
      const voice = parseVoiceAttachmentContent(message.content)
      if (voice) return `${voice.fileName}\n${voice.transcript}`
      const attachment = parseAttachmentContent(message.content, message)
      return attachment ? [attachment.fileName, attachment.caption].filter(Boolean).join('\n') : ''
    }
    case 'card': {
      const card = parseComposerCard(message.content)
      if (!card) return message.content ?? ''
      if (card.type === 'schedule') return `${card.text}\n${card.scheduleLabel}`
      if (card.type === 'question') return [card.text, ...card.options].join('\n')
      return card.text
    }
    case 'system':
      return parseSystemNotice(message)?.kind === 'turn-failure' ? '' : message.content ?? ''
    case 'widget':
      return ''
  }
}
