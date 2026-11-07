import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { useMobileShell } from '@/hooks/useMobileShell';
import { useDebounce } from '@/session/renderer/lib/hooks/useDebounce';
import { messageForUser } from '@/lib/userFacingError';
import { rendererLogger } from '@/lib/log';
import { ChevronLeft, X } from '@/lib/icons';
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages';
import { formatCalendarDate } from '@/i18n/format';
import { Sheet } from '../ui/Sheet';
import { PaneHeader } from '../ui/Pane';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { ListRow } from '../ui/ListRow';
import { SearchField } from '../ui/SearchField';
import { PaneEmptyState } from '../ui/PaneEmptyState';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { TaskChatFilePreviewHost } from '../assistant/TaskChatFilePreviewHost';
import { ReadOnlyMessageBubble } from '../chat/ReadOnlyMessageBubble';
import { useMessageFilePreview } from '../chat/useMessageFilePreview';
import { notify } from '@/lib/notices';
import { useLegacyDmOwner } from './useLegacyDmOwner';
import { readLegacyDmList, readLegacyDmMessages, readSessionLegacyScope, mergeLegacyMessages, type LegacyDm, type LegacyDmScope } from './data';
import { legacyMessageBody } from './message-body';

const log = rendererLogger('legacy-dm-history');
const previewToast = (title: string, tier: 'error', description?: string) => { notify({ title, tier, description }); };

export function LegacyDmHistoryDialog({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const ownerUserId = useLegacyDmOwner();
  const { translate } = useSessionMessages();
  const mobile = useMobileShell();
  if (!ownerUserId) return null;
  return <Sheet onClose={onClose} desktopWidth="min(768px, 100%)" desktopHeight="680px" desktopMaxHeight="calc(100dvh - 32px)"
    fullScreenMobile ariaLabel={translate(sessionId ? 'legacyDm.history' : 'legacyDm.archive')} testId="legacy-dm-history">
    <TaskChatFilePreviewHost mobile={mobile}>
      <LegacyDmReader key={`${ownerUserId}:${sessionId ?? ''}`} scope={{ ownerUserId }} sessionId={sessionId} mobile={mobile} onClose={onClose} />
    </TaskChatFilePreviewHost>
  </Sheet>;
}

function LegacyDmReader({ scope: owner, sessionId, mobile, onClose }: {
  scope: LegacyDmScope; sessionId?: string; mobile: boolean; onClose: () => void;
}) {
  const { translate, locale } = useSessionMessages();
  const ownerUserId = owner.ownerUserId;
  const [scope, setScope] = useState<LegacyDmScope | null>(null);
  const [rows, setRows] = useState<LegacyDm[]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const search = useDebounce(query, 200);
  const [selected, setSelected] = useState<LegacyDm | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setRows([]); setAfter(null); setSelected(null); setLoading(true); setError(null); setScope(null);
    void (async () => {
      const nextScope = sessionId ? await readSessionLegacyScope(ownerUserId, sessionId) : { ownerUserId };
      if (!active || !nextScope) return;
      const page = await readLegacyDmList(nextScope, undefined, search);
      if (!active) return;
      setScope(nextScope); setRows(page.rows); setAfter(page.after);
      if (sessionId && page.rows.length === 1 && !page.after) setSelected(page.rows[0]);
    })().catch((cause: unknown) => {
      log.error({ error: cause }, 'legacy history list read failed');
      if (active) setError(cause);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ownerUserId, sessionId, search, retry]);

  const more = async () => {
    if (!scope || !after || loading) return;
    setLoading(true); setError(null);
    try {
      const page = await readLegacyDmList(scope, after, search);
      setRows(current => [...new Map([...current, ...page.rows].map(row => [row.id, row])).values()]); setAfter(page.after);
    } catch (cause) { log.error({ error: cause }, 'legacy archive page read failed'); setError(cause); }
    finally { setLoading(false); }
  };
  const title = translate(sessionId ? 'legacyDm.history' : 'legacyDm.archive');
  return <>
    <PaneHeader title={selected ? selected.name ?? translate('legacyDm.chatNumber', { number: selected.publicId }) : title}
      subtitle={translate('legacyDm.readOnly')} titleLevel="panel" mobile={mobile}
      leading={selected ? <IconButton aria-label={translate('common.back')} onClick={() => setSelected(null)}><ChevronLeft /></IconButton> : undefined}
      actions={<IconButton aria-label={translate('common.close')} onClick={onClose}><X /></IconButton>} />
    {selected && scope ? <LegacyDmTranscript key={selected.id} scope={scope} chat={selected} mobile={mobile} /> : <>
      <div className="px-4 py-3"><SearchField value={query} onChange={event => setQuery(event.target.value)} placeholder={translate('legacyDm.search')} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {rows.map(row => <ListRow key={row.id} title={row.name ?? translate('legacyDm.chatNumber', { number: row.publicId })}
          subtitle={<time dateTime={row.updatedAt}>{formatCalendarDate(Date.parse(row.updatedAt), locale)}</time>}
          trailing={<Button size="sm" variant="secondary" onClick={() => setSelected(row)}>{translate('sessionHistory.open')}</Button>} />)}
        {!loading && !error && rows.length === 0 && !after && <PaneEmptyState caption={translate('legacyDm.empty')} />}
        {error != null && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(error)} /><Button variant="ghost" onClick={() => setRetry(value => value + 1)}>{translate('common.retry')}</Button></>}
        {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
        {after && <Button variant="ghost" disabled={loading} onClick={() => void more()}>{translate('legacyDm.more')}</Button>}
      </div>
    </>}
  </>;
}

function LegacyDmTranscript({ scope, chat, mobile }: { scope: LegacyDmScope; chat: LegacyDm; mobile: boolean }) {
  const owner = useAvatarIdentity(scope.ownerUserId);
  const { t } = useTranslation('messaging');
  const { translate, locale } = useSessionMessages();
  const preview = useMessageFilePreview({ mobile, visible: true, closeRightSurfaces: () => {}, toast: previewToast, readOnly: true });
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef<{ top: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void readLegacyDmMessages(scope, chat.id).then(page => {
      if (active) { setMessages(page.rows); setBefore(page.beforeSeq); }
    }).catch((cause: unknown) => {
      log.error({ error: cause }, 'legacy messages read failed');
      if (active) setError(cause);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope, chat.id, retry]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = position.current ? position.current.top + scroll.current.scrollHeight - position.current.height : scroll.current.scrollHeight;
    position.current = null;
  }, [messages]);
  const older = async () => {
    if (before === null || loading) return;
    setLoading(true); setError(null);
    try {
      const page = await readLegacyDmMessages(scope, chat.id, before);
      if (scroll.current) position.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
      setMessages(current => mergeLegacyMessages(page.rows, current)); setBefore(page.beforeSeq);
    } catch (cause) { log.error({ error: cause }, 'older legacy messages read failed'); setError(cause); }
    finally { setLoading(false); }
  };
  return <>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto py-3" data-testid="legacy-dm-messages">
      {before !== null && <Button variant="ghost" disabled={loading} onClick={() => void older()}>{translate('legacyDm.older')}</Button>}
      {messages.map(message => <ReadOnlyMessageBubble key={message.id} message={message} mobile={mobile} fileCardsOnly
        body={legacyMessageBody(message, t('message.retracted'))}
        sender={message.is_mine ? { display_name: owner?.display_name ?? '', avatar: owner?.avatar, type: 'human' }
          : chat.agent && message.sender_user_id === chat.agent.id ? chat.agent : { display_name: translate('legacyDm.unknownSender') }}
        timestamp={<time dateTime={message.created_at}> · {formatCalendarDate(Date.parse(message.created_at), locale)}</time>}
        onOpenFile={file => preview.open(file, message)} />)}
      {loading && <LoadingIndicator size="panel" ariaLabel={translate('sessionImport.previewLoading')} />}
      {error != null && <><PaneEmptyState caption={translate('legacyDm.failed')} hint={messageForUser(error)} /><Button variant="ghost" onClick={() => setRetry(value => value + 1)}>{translate('common.retry')}</Button></>}
      {!loading && !error && !messages.length && <PaneEmptyState caption={translate('legacyDm.empty')} />}
    </div>
    {preview.panel}
  </>;
}
