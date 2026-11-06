/** @jsxImportSource solid-js */
import type { ChatMessage } from '@session-chat/model';
import { useChatTranslator } from '@session-chat/localization';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import * as styles from './activity.css';

export function GroupReply(props: { message: ChatMessage }) {
  const t = useChatTranslator(), commands = useCommands();
  const label = () => t('transcript.activityReplyToYou', { name: props.message.groupReply!.name,
    text: props.message.text.trim().split(/\n|(?<=[。！？.!?])\s/)[0] });
  return <div class={styles.groupReply} data-group-reply={props.message.id}><button type="button" class={styles.groupReplyButton}
    onClick={() => {
      const group = props.message.groupReply!.target;
      if (group.kind === 'chat') commands().onOpenSender?.({ ...group, messageId: /:sent:([^:]+)$/.exec(props.message.id)?.[1] });
    }} title={label()}>{label()} ›</button></div>;
}
