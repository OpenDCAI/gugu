import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Popover } from '@/components/ui/Popover';
import { CalendarClock, ChevronDown, ChevronUp, Info, MessageCircle, Plug } from '@/lib/icons';
import { collapsedRows, dayRows, defaultOpen, eventStatus, isTodayAgenda, joinNow, type DayRows, type EventStatus } from './assistant-day';
import type { DayEvent, TodayDay, TodayPart } from './assistant-today-file';

type T = ReturnType<typeof useTranslation<'assistant'>>['t'];

export type DayCardProps = {
  part: TodayPart<TodayDay>;
  name: string;
  askInChat: (draft: string) => void;
  /** 「管理连接器」去哪(桌面:<名字> → 连接应用);没给 = 这一端没有那一页(手机先不加),只说一句在哪管。 */
  onManageConnectors?: () => void;
};

/** 此刻的钟点,每半分钟走一格(「即将开始 / 进行中 / N 分钟后结束」跟着变)。 */
function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

/**
 * #7199 「动态」页最上面那张「日程进展」:今天的安排是它从连接的日历、这台电脑 / 手机的日历、
 * 邮件与聊天里排好写进 today.json 的(它就是我们的服务端),这里只照着画、按此刻的钟点算状态。
 * 快开或正在开、带会议链接的,行上直接给「加入会议」;右上「来源」说清从哪来,带「管理连接器」。
 * 没排 / 排的不是今天 / 今天没事 / 这一块读不懂,各说各的,❌ 混成一句「暂无」。
 */
export function DayInProgressCard({ part, name, askInChat, onManageConnectors }: DayCardProps) {
  const { t } = useTranslation('assistant');
  const now = useNow();
  const today = new Date(now);
  const agenda = part.state === 'ok' && isTodayAgenda(part.value, today) ? part.value : null;
  return (
    <section className="ta-card ta-day" data-testid="assistant-day" data-state={part.state === 'invalid' ? 'invalid' : agenda ? 'ok' : 'none'}>
      <div className="ta-day-head">
        <span className="ta-day-label">
          <CalendarClock />
          {t('today.agenda.title')}
        </span>
        <DaySources name={name} onManageConnectors={onManageConnectors} />
      </div>
      {part.state === 'invalid' ? (
        <DayNote
          text={t('today.agenda.invalid', { name, problem: part.problem })}
          action={t('today.fix', { name })}
          onAction={() => askInChat(t('today.fixPrompt', { problem: part.problem }))}
        />
      ) : !agenda ? (
        <DayNote
          title={t('today.agenda.emptyTitle')}
          text={
            part.state === 'ok'
              ? t('today.agenda.stale', { name, date: shortDate(part.value.localDate, t) })
              : undefined
          }
          action={t('today.agenda.plan', { name })}
          onAction={() => askInChat(t('today.agenda.planPrompt'))}
          testId="assistant-day-empty"
        />
      ) : agenda.events.length === 0 ? (
        <DayNote text={t('today.agenda.none')} testId="assistant-day-none" />
      ) : (
        <DayList rows={dayRows(agenda.events, now)} now={now} name={name} askInChat={askInChat} t={t} />
      )}
    </section>
  );
}

function DayNote({ title, text, action, onAction, testId }: { title?: string; text?: string; action?: string; onAction?: () => void; testId?: string }) {
  return (
    <div className="ta-day-note" data-testid={testId}>
      {title ? <span className="ta-day-note-title">{title}</span> : null}
      {text ? <span>{text}</span> : null}
      {action && onAction ? (
        <div>
          <button type="button" className="ta-pill-btn" onClick={onAction}>
            {action}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DayList({ rows, now, name, askInChat, t }: { rows: DayRows; now: number; name: string; askInChat: (draft: string) => void; t: T }) {
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const { visible, hidden } = collapsedRows(rows);
  const shown = expanded ? rows : visible;
  // 没人点过 = 默认展开第一件还没完的事;点过一次就听人的。
  const openId = open === undefined ? defaultOpen(rows) : open;
  const row = (event: DayEvent) => (
    <DayRow
      key={event.id}
      event={event}
      status={eventStatus(event, now)}
      open={openId === event.id}
      onToggle={() => setOpen(openId === event.id ? null : event.id)}
      name={name}
      askInChat={askInChat}
      t={t}
    />
  );
  return (
    <div className="ta-day-list">
      {shown.allDay.map(row)}
      {shown.coming.map(row)}
      {shown.past.length > 0 ? (
        <div className="ta-day-divider" role="separator">
          <span>{t('today.agenda.past')}</span>
        </div>
      ) : null}
      {shown.past.map(row)}
      {hidden > 0 ? (
        <button type="button" className="ta-day-more" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} data-testid="assistant-day-more">
          {expanded ? t('today.agenda.showLess') : t('today.agenda.showMore', { count: hidden })}
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </button>
      ) : null}
    </div>
  );
}

function DayRow({ event, status, open, onToggle, name, askInChat, t }: { event: DayEvent; status: EventStatus; open: boolean; onToggle: () => void; name: string; askInChat: (draft: string) => void; t: T }) {
  const time = timeRange(event, t);
  const join = () => event.joinUrl && window.open(event.joinUrl, '_blank', 'noopener');
  const color = event.color ?? undefined;
  return (
    <div className="ta-day-row" data-status={status.kind} data-open={open || undefined} data-testid={`assistant-day-event-${event.id}`}>
      <div className="ta-day-row-line">
        <button type="button" className="ta-day-row-main" onClick={onToggle} aria-expanded={open}>
          {event.allDay ? <span className="ta-day-ring" style={{ borderColor: color }} aria-hidden /> : <span className="ta-day-bar" style={{ background: color }} aria-hidden />}
          <span className="ta-day-body">
            <span className="ta-day-title">{event.title}</span>
            <span className="ta-day-time">
              {time}
              {statusLabel(status, t) ? <span className="ta-day-status"> · {statusLabel(status, t)}</span> : null}
            </span>
          </span>
        </button>
        {joinNow(event, status) && !open ? (
          <button type="button" className="ta-day-btn" data-tone="primary" onClick={join} data-testid={`assistant-day-join-${event.id}`}>
            {t('today.agenda.join')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="ta-day-detail">
          {event.description ? <p className="ta-day-desc">{event.description}</p> : null}
          {event.source ? <span className="ta-day-source">{t('today.agenda.from', { source: event.source })}</span> : null}
          <div className="ta-day-actions">
            {event.joinUrl ? (
              <button type="button" className="ta-day-btn" data-tone="primary" onClick={join} data-testid={`assistant-day-join-${event.id}`}>
                {t('today.agenda.join')}
              </button>
            ) : null}
            <button type="button" className="ta-day-btn" onClick={() => askInChat(t('today.agenda.askPrompt', { title: event.title, time }))}>
              <MessageCircle />
              {t('today.agenda.chat', { name })}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 右上「来源」:它从哪几处排今天的安排(只列我们真读得到的),底下「管理连接器」。 */
function DaySources({ name, onManageConnectors }: { name: string; onManageConnectors?: () => void }) {
  const { t } = useTranslation('assistant');
  const [open, setOpen] = useState(false);
  const kinds = ['calendar', 'mail', 'chat'] as const;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="ta-day-source-btn" data-testid="assistant-day-sources">
        <Info />
        {t('today.agenda.source')}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={12}>
          <Popover.Popup className="ta-dialog ta-day-pop" data-testid="assistant-day-sources-pop">
            <h3 className="ta-dialog-title">{t('today.agenda.sourcesTitle')}</h3>
            <ul className="ta-day-kinds">
              {kinds.map((kind) => (
                <li key={kind}>
                  <span className="ta-tile-title">{t(`today.agenda.kind.${kind}.title`)}</span>
                  <span className="ta-tile-sub">{t(`today.agenda.kind.${kind}.body`, { name })}</span>
                  <span className="ta-day-kind-from">{t(`today.agenda.kind.${kind}.from`, { name })}</span>
                </li>
              ))}
            </ul>
            {onManageConnectors ? (
              <button
                type="button"
                className="ta-wide-btn"
                data-tone="primary"
                onClick={() => {
                  setOpen(false);
                  onManageConnectors();
                }}
                data-testid="assistant-day-connectors"
              >
                <Plug />
                {t('today.agenda.manage')}
              </button>
            ) : (
              <p className="ta-page-sub">{t('today.agenda.manageElsewhere', { name })}</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function statusLabel(status: EventStatus, t: T): string | null {
  if (status.kind === 'soon') return t('today.agenda.soon');
  if (status.kind === 'now') return t('today.agenda.now');
  if (status.kind === 'ending') return t('today.agenda.ending', { count: status.minutes });
  return null;
}

/** 「09:00 – 10:00」(24 小时制,这台设备的时区);全天的写「全天」;没写结束的只写开始。 */
function timeRange(event: DayEvent, t: T): string {
  if (event.allDay || !event.start) return t('today.agenda.allDay');
  const clock = new Intl.DateTimeFormat(t('today.locale'), { hour: '2-digit', minute: '2-digit', hour12: false });
  const start = clock.format(new Date(event.start));
  return event.end ? `${start} – ${clock.format(new Date(event.end))}` : start;
}

function shortDate(localDate: string, t: T): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Intl.DateTimeFormat(t('today.locale'), { month: 'long', day: 'numeric' }).format(new Date(year, month - 1, day));
}
