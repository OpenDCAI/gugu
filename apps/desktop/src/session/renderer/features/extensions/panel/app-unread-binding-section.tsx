import { useState, useSyncExternalStore } from 'react';
import { ChatPickSheet } from '@/components/chat/ChatPickSheet';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import type { SessionTranslate } from '../extension-consent';

export type UnreadBindingApi = Pick<typeof rpc.extensions, 'unreadBindingChoices' | 'setUnreadBinding'>;
const accountId = () => readSelfIdentityBridge()?.getSnapshot()?.userId ?? null;
const subscribeAccount = (listener: () => void) => readSelfIdentityBridge()?.subscribe(listener) ?? (() => {});
type Choices = NonNullable<Awaited<ReturnType<UnreadBindingApi['unreadBindingChoices']>>['data']>;

/** The common permission surface owns selection. No App page can invoke this editor. */
export function AppUnreadBindingSection(props: { extensionId: string; name: string; api: UnreadBindingApi; translate: SessionTranslate; disabled: boolean }) {
  const ownerId = useSyncExternalStore(subscribeAccount, accountId, () => null);
  return ownerId ? <UnreadBindingChooser key={`${ownerId}/${props.extensionId}/${props.name}`} {...props} ownerId={ownerId} /> : null;
}

function UnreadBindingChooser({ extensionId, name, api, translate, disabled, ownerId }: {
  extensionId: string; name: string; api: UnreadBindingApi; translate: SessionTranslate; disabled: boolean; ownerId: string;
}) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true);
    try {
      const result = await api.unreadBindingChoices({ extensionId, name });
      if (!result.success || !result.data || result.data.ownerId !== ownerId || accountId() !== ownerId) throw new Error('Conversation selection is unavailable');
      setChoices(result.data);
      setSelected(new Set(result.data.selected ? [result.data.selected] : []));
      setQuery(''); setError('');
    } catch (cause) {
      log.error('Could not read App unread binding choices', cause);
      if (accountId() === ownerId) setError(translate('extensions.unreadBindingReadFailed'));
    } finally { setBusy(false); }
  }
  async function save(chatId: string | null) {
    setBusy(true);
    try {
      if (!choices || accountId() !== ownerId) throw new Error('Account changed');
      const result = await api.setUnreadBinding({ extensionId, name, ownerId, authority: choices.authority, chatId });
      if (!result.success) throw new Error(result.error);
      if (accountId() === ownerId) { setChoices(null); setError(''); }
    } catch (cause) {
      log.error('Could not save App unread binding', cause);
      if (accountId() === ownerId) setError(translate('extensions.unreadBindingFailed'));
    } finally { setBusy(false); }
  }
  return <>
    <button type="button" className="mk-link" disabled={disabled || busy} onClick={() => void open()} data-testid="app-unread-binding-choose">
      {translate('extensions.unreadBindingChoose')}
    </button>
    {error && !choices ? <p role="alert">{error}</p> : null}
    {choices && !disabled ? <ChatPickSheet
      title={translate('extensions.unreadBindingTitle')}
      testId="app-unread-binding-sheet"
      onClose={() => { if (!busy) setChoices(null); }}
      rows={choices.chats.filter(chat => chat.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(chat => ({
        id: chat.id, name: chat.name, avatar: { name: chat.name, seed: chat.id, ...(chat.kind === 'group' || chat.kind === 'topic' ? { variant: 'group' as const } : {}) },
      }))}
      selected={selected} onToggle={id => { if (!busy) setSelected(new Set([id])); }}
      query={query} onQuery={setQuery} placeholder={translate('extensions.unreadBindingSearch')} empty={translate('extensions.unreadBindingEmpty')}
      actionLabel={translate('extensions.unreadBindingSave')} actionDisabled={busy || selected.size !== 1}
      onAction={() => void save([...selected][0]!)} error={error}
      above={choices.selected ? <button type="button" className="mk-link" disabled={busy} onClick={() => void save(null)}>{translate('extensions.unreadBindingRemove')}</button> : undefined}
    /> : null}
  </>;
}
