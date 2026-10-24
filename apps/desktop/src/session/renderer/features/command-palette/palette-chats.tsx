import { Command } from 'cmdk';
import { Users } from '@/lib/icons';
import { useChatSummaries, useContactSummaries } from '@/lib/chatSummariesBridge';
import { openConversationLink } from '@/lib/conversationLinks';
import { UI_EVENTS } from '@/lib/uiEvents';
import { conversationLink } from '@gugu/core/shared/ui/conversationLink';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

export function PaletteChatGroups({ query, groupClassName, onClose }: {
  query: string; groupClassName: string; onClose: () => void;
}) {
  const { translate } = useSessionMessages();
  const summaries = useChatSummaries();
  const contacts = useContactSummaries();
  const q = query.trim().toLocaleLowerCase();
  const matches = (name: string | null) => !!name && (!q || name.toLocaleLowerCase().includes(q));
  const groups = [...summaries].filter(([id, chat]) => chat.kind === 'group'
    && !projectGroupsStore.projectOfChat(id) && matches(chat.name)).slice(0, q ? 20 : 5);
  const people = contacts.filter((contact) => matches(contact.name)).slice(0, q ? 20 : 5);
  return (
    <>
      {groups.length > 0 && (
        <Command.Group heading={translate('palette.groups')} className={groupClassName}>
          {groups.map(([id, chat]) => (
            <Command.Item key={id} value={`chat:${id}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => { onClose(); openConversationLink(conversationLink(id)); }}>
              <Users size={14} className="shrink-0 text-foreground/40" /><span className="flex-1 truncate">{chat.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
      {people.length > 0 && (
        <Command.Group heading={translate('palette.contacts')} className={groupClassName}>
          {people.map((contact) => (
            <Command.Item key={contact.id} value={`contact:${contact.id}`} className={PALETTE_ITEM_CLASS}
              onSelect={() => { onClose(); window.dispatchEvent(new CustomEvent(UI_EVENTS.openContact, { detail: contact.id })); }}>
              <Users size={14} className="shrink-0 text-foreground/40" /><span className="flex-1 truncate">{contact.name}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );
}
