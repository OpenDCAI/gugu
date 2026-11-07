import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels';
import { downloadAttachment } from '@/lib/attachmentBytes';
import { useToast } from '../toastContext';
import { messageForUser } from '@/lib/userFacingError';
import { Avatar } from '../Avatar';
import { Markdown } from '../markdown/Markdown';
import { buildBubbleStyle } from './messageBubbleStyle';
import { MediaAttachmentBubble } from './MediaAttachmentBubble';
import { FileAttachmentCard } from './FileAttachmentCard';
import '../assistant/assistant-task-chat.css';

/** Shared presentation of read-only evidence; no IM actions, write watermark or runtime subscription. */
export function ReadOnlyMessageBubble({ message, mobile, body, sender, timestamp, fileCardsOnly = false, onOpenFile }: {
  message: MessageItem; mobile: boolean;
  body: { text: string; files: ParsedAttachment[]; invalidAttachments: boolean };
  sender: { display_name: string; avatar?: string | null; type?: string };
  timestamp?: ReactNode;
  fileCardsOnly?: boolean;
  onOpenFile?: (file: ParsedAttachment) => void;
}) {
  const { t } = useTranslation('messaging');
  const { toast } = useToast();
  const download = async (file: ParsedAttachment) => {
    try { await downloadAttachment(file.source, file.fileName); }
    catch (error) { toast(t('chatArea.downloadFailed'), 'error', messageForUser(error)); }
  };
  if (!body.text && body.files.length === 0 && !body.invalidAttachments) return null;
  return <div data-task-exchange="true" data-message-id={message.id} data-mobile={mobile || undefined} data-own={message.is_mine || undefined} className="task-exchange">
    <Avatar seed={message.sender_user_id ?? undefined} name={sender.display_name} avatarUrl={sender.avatar} size="sm" isAgent={sender.type !== 'human'} still harnessBadge={false} />
    <div className="task-exchange__column">
      <div data-message-sender-name="true" className="task-exchange__who">{sender.display_name}{timestamp}</div>
      <div style={buildBubbleStyle(message.is_mine, !!message.is_whisper, mobile)}>
        {body.text && <Markdown trust="chat" content={body.text} />}
        {body.files.map((file, index) => fileCardsOnly
          ? <FileAttachmentCard key={index} file={file} isMine={message.is_mine}
              versionLabel={file.source.kind === 'item' && file.source.version > 1 ? t('attachmentView.fileVersion', { n: file.source.version }) : undefined}
              onOpen={file.source.kind === 'gone' ? undefined : () => onOpenFile?.(file)}
              onDownload={file.source.kind === 'gone' ? undefined : () => void download(file)} downloadLabel={t('chatArea.filePreview.download')} />
          : <MediaAttachmentBubble key={`${file.source.kind === 'attachment' ? file.source.attachmentId : index}:${index}`}
              meta={file} messageId={message.id} isMine={message.is_mine} onOpenFile={onOpenFile} onDownload={() => void download(file)} />)}
        {body.invalidAttachments && <span role="alert">{t('attachmentView.fileUnavailable')}</span>}
      </div>
    </div>
  </div>;
}
