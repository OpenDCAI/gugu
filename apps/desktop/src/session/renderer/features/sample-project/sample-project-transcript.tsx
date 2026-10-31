import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { EngineIcon } from '@/components/AgentHarnessIdentity';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import { BODY_COLORS } from '@/components/agentAvatar/engine/identity';
import { resolveAgentLook } from '@/components/agentAvatar/look';
import { ComposerCardFrame, TaskCardHandedTo, TaskStatusMark } from '@/components/chat/ComposerCardView';
import { FileAttachmentCard } from '@/components/chat/FileAttachmentCard';
import { MessageQuoteFrame } from '@/components/chat/MessageQuote';
import { buildBubbleStyle } from '@/components/chat/messageBubbleStyle';
import { useMentionRender } from '@/components/chat/useMentionRender';
import '@/components/chat/messageBubbleChrome.css';
import { Markdown } from '@/components/markdown/Markdown';
import { Chip } from '@/components/ui/Chip';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import type { SampleFile, SampleMessage, SampleProjectContent } from './content/types';
import type { SampleProjectOwner } from './use-sample-project';

/** 示例里那个 agent 的身份种子:定它的默认形象和名字颜色,❌ 去查任何真 agent。 */
export const SAMPLE_AGENT_SEED = 'sample-project:codex';

export function sampleFileBytes(file: SampleFile): number {
  return new TextEncoder().encode(file.text).length;
}

const senderOf = (message: SampleMessage) => (message.kind === 'task' ? 'owner' : message.from);

/**
 * 示例项目群里那段已经发生过的对话(#709):一次真跑固化下来的。长相照群聊(MessageBubble 那一套量值、气泡、分组、时刻、
 * 任务卡、文件卡、引用、@),但这是读的 ❌ 悬停菜单、回应、已读 —— 那些在这里什么都做不了,就不画。
 */
export function SampleProjectTranscript({ content, owner, onOpenFile, onOpenTask }: {
  content: SampleProjectContent;
  owner: SampleProjectOwner;
  onOpenFile: (fileId: string) => void;
  onOpenTask: () => void;
}) {
  const { messages } = content;
  return (
    <div role="list" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4" data-sample-transcript="">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        const next = messages[index + 1];
        // 群聊同一条(computeGroupedWithPrev):同一个人、中间没另起时刻,就并成一组 —— 任务卡也算它发的人的。
        const groupedWithPrev = !!previous && !message.divider && senderOf(previous) === senderOf(message);
        const groupedWithNext = !!next && !next.divider && senderOf(next) === senderOf(message);
        return (
          <div key={message.id} role="listitem" className="flow-root" style={{ paddingBottom: 'var(--spacing-xs)' }}>
            {message.divider ? (
              <div style={{ textAlign: 'center', margin: 'var(--spacing-sm) 0 var(--spacing-xs)', userSelect: 'none' }}>
                <Chip>{message.time}</Chip>
              </div>
            ) : null}
            <SampleMessageRow
              message={message}
              content={content}
              owner={owner}
              groupedWithPrev={groupedWithPrev}
              groupedWithNext={groupedWithNext}
              onOpenFile={onOpenFile}
              onOpenTask={onOpenTask}
            />
          </div>
        );
      })}
    </div>
  );
}

function SampleMessageRow({ message, content, owner, groupedWithPrev, groupedWithNext, onOpenFile, onOpenTask }: {
  message: SampleMessage;
  content: SampleProjectContent;
  owner: SampleProjectOwner;
  groupedWithPrev: boolean;
  groupedWithNext: boolean;
  onOpenFile: (fileId: string) => void;
  onOpenTask: () => void;
}) {
  const { t } = useTranslation('messaging');
  const mine = senderOf(message) === 'owner';
  const card = message.kind === 'task';
  const avatar = mine
    ? <Avatar name={owner.name} avatarUrl={owner.avatarUrl} seed={owner.id} size="sm" still />
    : <SampleAgentAvatar name={content.agent.name} />;
  let body: ReactNode;
  if (message.kind === 'task') {
    body = (
      <ComposerCardFrame
        cardType="task"
        mark={<EngineIcon engine={content.agent.engine} size={13} />}
        title={t('message.taskCard.task')}
        time={message.time}
        text={message.text}
        onOpen={onOpenTask}
        tour="sample-task-card"
      >
        <TaskCardHandedTo agentName={content.agent.name} agentAvatar={null} agentUserId={SAMPLE_AGENT_SEED} note="" mark={<TaskStatusMark status="idle" />} />
      </ComposerCardFrame>
    );
  } else if (message.kind === 'file') {
    const file = content.files.find((entry) => entry.id === message.file)!;
    body = (
      <>
        <div className="max-w-full">
          <FileAttachmentCard
            file={{ fileName: file.name, sizeBytes: sampleFileBytes(file), mimeType: file.mimeType }}
            isMine={mine}
            onOpen={() => onOpenFile(file.id)}
          />
        </div>
        <SampleTime time={message.time} mine={mine} inline={false} />
      </>
    );
  } else {
    const quoted = message.replyTo ? content.messages.find((entry) => entry.id === message.replyTo) : undefined;
    body = (
      <>
        {quoted ? <SampleQuote quoted={quoted} mine={mine} content={content} owner={owner} /> : null}
        <SampleText message={message} owner={owner} onOpenFile={onOpenFile} />
        <SampleTime time={message.time} mine={mine} inline />
      </>
    );
  }
  const showSender = !mine && !groupedWithPrev && !card;
  return (
    <div
      style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-start', gap: '11px', padding: groupedWithPrev ? '1px 14px' : '5px 14px' }}
      data-sample-message={message.id}
    >
      <div className="w-[32px] shrink-0 self-end">{groupedWithNext ? null : avatar}</div>
      <div
        style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', flexBasis: '70%', maxWidth: '70%', minWidth: 0, containerType: 'inline-size', gap: '3px' }}
      >
        <div style={{ width: '100%', minWidth: 0 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: '4px', width: 'fit-content', maxWidth: '100%', minWidth: 0, marginLeft: mine ? 'auto' : undefined }}>
            <div
              style={card ? { maxWidth: '100cqw' } : buildBubbleStyle(mine, false, false, groupedWithPrev)}
              data-bubble-tail={!card && !groupedWithNext ? (mine ? 'mine' : 'other') : undefined}
            >
              {showSender ? <SampleAgentSender name={content.agent.name} /> : null}
              {body}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 正文:群里回给人的那条,开头 @ 的是看它的这个人(照群聊 useMentionRender 那样高亮);正文里的群文件链接打开示例自己的文件 ——
 * 在 Markdown 把它交给 followLink(会去开真文件)之前接住。
 */
function SampleText({ message, owner, onOpenFile }: { message: Extract<SampleMessage, { kind: 'text' }>; owner: SampleProjectOwner; onOpenFile: (fileId: string) => void }) {
  const mine = message.from === 'owner';
  const mention = message.mentionsOwner && owner.name ? owner : null;
  const text = mention ? `@${mention.name} ${message.text}` : message.text;
  const rendered = useMentionRender(
    { content: text, to_user_ids: mention ? [mention.id] : [], is_whisper: false, reply_to_sender_user_id: null },
    true,
    mention ? ({ [mention.id]: { displayName: mention.name } } as unknown as Record<string, MemberProfileCardModel>) : undefined,
  );
  const claimFileLink = (event: MouseEvent) => {
    const href = (event.target as Element).closest('a')?.getAttribute('href');
    const link = href ? parseGroupFileLink(href) : null;
    if (!link) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenFile(link.itemId);
  };
  return (
    <div
      className="msg-time-room"
      onClickCapture={claimFileLink}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', '--msg-time-room': `"${message.time}"` } as CSSProperties}
    >
      <Markdown trust="chat" content={rendered.content ?? text} mentionMarker={rendered.mentionMarker} onAccent={mine} hardBreaks={mine} />
    </div>
  );
}

/** agent 回群时引的那一条(它自己那张任务卡,或人说的话),画群聊引用块那一面。 */
function SampleQuote({ quoted, mine, content, owner }: { quoted: SampleMessage; mine: boolean; content: SampleProjectContent; owner: SampleProjectOwner }) {
  const { t } = useTranslation('messaging');
  if (quoted.kind === 'task') {
    const head = (
      <span className="inline-flex items-center gap-1 align-middle">
        <EngineIcon engine={content.agent.engine} size={12} />
        {t('message.taskCard.task')}
      </span>
    );
    return <MessageQuoteFrame mine={mine} head={head} text={quoted.text} />;
  }
  const name = senderOf(quoted) === 'owner' ? owner.name : content.agent.name;
  return <MessageQuoteFrame mine={mine} head={name} text={quoted.kind === 'text' ? quoted.text : ''} />;
}

/** 气泡里的时刻,和群聊同一个样式(这里写着的就是那一刻)。 */
function SampleTime({ time, mine, inline }: { time: string; mine: boolean; inline: boolean }) {
  return <span data-message-time="true" data-mine={mine || undefined} data-inline={inline || undefined} className="msg-time">{time}</span>;
}

/** 群里收到的、一组的第一条:名字 + 「我的 agent」,和 BubbleSender 同一个样子(那一个要查真 agent 的主人)。 */
function SampleAgentSender({ name }: { name: string }) {
  const { t } = useTranslation('messaging');
  const hue = BODY_COLORS[resolveAgentLook(SAMPLE_AGENT_SEED, null).color].hue;
  return (
    <div data-message-who="true" data-message-sender-name="true" className="msg-sender" style={{ '--member-hue': hue } as CSSProperties}>
      <span className="msg-sender-name">{name}</span>
      <Chip appearance="filled">{t('message.myAgentTag')}</Chip>
    </div>
  );
}

/** agent 的头像 + 右下角的引擎角标。角标照 AgentHarnessBadge 的量值自己画:那一枚要按 agent id 去查真 agent 的引擎。 */
export function SampleAgentAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const badge = Math.max(10, Math.min(24, Math.round(size * 0.44)));
  return (
    <span className="relative inline-flex">
      <Avatar name={name} avatarUrl={null} seed={SAMPLE_AGENT_SEED} size={size} isAgent harnessBadge={false} still />
      <span className="agent-harness-badge" style={{ '--agent-harness-size': `${badge}px` } as CSSProperties}>
        <EngineIcon engine="codex" size={badge - 4} />
      </span>
    </span>
  );
}
