import type { MessageItem } from '@gugu/core/shared/types/chat';
import { parseAttachmentContent, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels';
import { parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels';
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels';

/** Project an original message without converting it into a new native turn or an interactive card. */
export function legacyMessageBody(message: MessageItem, retractedText: string): { text: string; files: ParsedAttachment[]; invalidAttachments: boolean } {
  if (message.retracted_at) return { text: retractedText, files: [], invalidAttachments: false };
  if (message.content_type !== 'attachment') return {
    text: message.content_type === 'widget' ? parseWidgetMessage(message.content)?.text ?? message.content ?? '' : message.content ?? '',
    files: [], invalidAttachments: false,
  };
  const voice = parseVoiceAttachmentContent(message.content);
  if (voice) return { text: voice.transcript || voice.fileName, files: [], invalidAttachments: false };
  const file = parseAttachmentContent(message.content, message);
  return { text: '', files: file ? [file] : [], invalidAttachments: !file };
}
