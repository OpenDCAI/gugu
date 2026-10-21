import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import { LayoutGrid, MoreHorizontal, Pencil, RefreshCw, Sparkles, Sun, Trash2 } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { rendererLogger } from '@/lib/log';
import { DayInProgressCard } from './assistant-day-card';
import { dayOf, feedOrder, TodayReadError, type TodayBatch, type TodayRead, type TodayWidget } from './assistant-today-file';
import { AssistantEmpty, AssistantSection } from './assistant-ui-parts';

const log = rendererLogger('assistant/today');

type T = ReturnType<typeof useTranslation<'assistant'>>['t'];

/** 页面此刻读到哪一步:还在读 / 读不到(带重试)/ 读到了(第一天、有简报、读不懂)。 */
export type TodayFeedView = { state: 'loading' } | { state: 'error'; error: unknown; retry: () => void } | { state: 'read'; read: TodayRead };

export type TodayFeedProps = {
  view: TodayFeedView;
  assistantName: string;
  ownerName: string | null;
  /** 把这句话填进和它的聊天输入框(只填不发,人看过再发)。 */
  askInChat: (draft: string) => void;
  /** 一段 markdown 画成什么样:桌面会话页与手机壳各用各的渲染器(链接怎么开不一样),内容一样。 */
  renderMarkdown: (markdown: string) => ReactNode;
  /** 「添加组件」:打开「发现组件」(桌面对话框 / 手机推一页)。 */
  onAddWidget: () => void;
  /** 日程进展「来源」里的「管理连接器」;没有那一页的一端不给。 */
  onManageConnectors?: () => void;
};

/**
 * 「动态」页的信息流(简报信息流),桌面「助理」视图与手机壳里的助理 App 共用;读 today.json 的那一步各自做。
 * 有简报:日程进展 → 小组件 →「获取我的最新简报」→ 一批一段(晨间简报 / 晚间简报 / 日记,段头是哪一天)→ 底部那句。
 * 还没写过(第一天):你好 + 它在了解你 → 日程进展 →「获取我的最新简报」→ 小组件的空态。读不到 / 读不懂如实说,❌ 当成第一天。
 * 日程进展固定在最上面(钉在当天最上面)。
 * 各个按钮都不弹表单:往聊天里填一句,人看过再发。
 */
export function AssistantTodayFeed({ view, assistantName: name, ownerName, askInChat, renderMarkdown, onAddWidget, onManageConnectors }: TodayFeedProps) {
  const { t } = useTranslation('assistant');
  const error = view.state === 'error' ? view.error : null;
  useEffect(() => {
    // 原因(读法答的 kind 与原文)进日志,文案只给用户能照做的下一步(user-copy-leak-check)。
    if (error) log.warn({ kind: error instanceof TodayReadError ? error.kind : 'unknown', error: error instanceof Error ? error.message : String(error) }, 'today.json 读不到');
  }, [error]);

  if (view.state === 'loading') {
    return (
      <div className="ta-page" data-testid="assistant-today-loading">
        <AssistantEmpty>
          <span className="inline-flex items-center gap-2">
            <LoadingIndicator size="inline" />
            {t('today.loading')}
          </span>
        </AssistantEmpty>
      </div>
    );
  }
  if (view.state === 'error') {
    return (
      <div className="ta-page" data-testid="assistant-today-unreadable">
        <AssistantEmpty
          title={t('today.unreadableTitle')}
          action={
            <button type="button" className="ta-pill-btn" onClick={view.retry} data-testid="assistant-today-retry">
              {t('machine.retry')}
            </button>
          }
        >
          {unreadableCopy(t, view.error, name)}
        </AssistantEmpty>
      </div>
    );
  }
  const read = view.read;
  if (read.state === 'invalid') {
    return (
      <div className="ta-page" data-testid="assistant-today-invalid">
        <AssistantEmpty
          title={t('today.invalidTitle')}
          action={
            <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('today.fixPrompt', { problem: read.problem }))}>
              {t('today.fix', { name })}
            </button>
          }
        >
          {t('today.invalid', { name, problem: read.problem })}
        </AssistantEmpty>
      </div>
    );
  }
  const batches = read.state === 'ok' ? feedOrder(read.file.batches) : [];
  const widgets = read.state === 'ok' ? read.file.widgets : [];
  const parts = { name, askInChat, renderMarkdown, t };
  const day = <DayInProgressCard part={read.state === 'ok' ? read.file.day : { state: 'none' }} name={name} askInChat={askInChat} onManageConnectors={onManageConnectors} />;

  if (batches.length === 0) {
    const owner = ownerName || t('header.you');
    return (
      <div className="ta-page" data-testid="assistant-today">
        <div className="ta-card ta-today-hello">
          <h1 className="ta-hero-name">{t('today.hello', { owner })}</h1>
          <p className="ta-hero-since">{t('today.learning', { name })}</p>
        </div>
        {day}
        <BriefButton {...parts} />
        <Widgets widgets={widgets} onAdd={onAddWidget} {...parts} />
        <p className="ta-page-sub ta-pad text-center">{t('today.feedEnd')}</p>
      </div>
    );
  }
  const now = new Date();
  return (
    <div className="ta-page" data-testid="assistant-today">
      {day}
      <Widgets widgets={widgets} onAdd={onAddWidget} {...parts} />
      <BriefButton {...parts} />
      {batches.map((batch) => (
        <AssistantSection
          key={batch.id}
          title={t(`today.kind.${batch.kind}`)}
          action={<span className="ta-tile-sub ta-pad">{dateLabel(batch.localDate, now, t)}</span>}
          bare
          testId={`assistant-today-batch-${batch.id}`}
        >
          <BatchCards batch={batch} {...parts} />
        </AssistantSection>
      ))}
      <p className="ta-page-sub ta-pad text-center">{t('today.feedEnd')}</p>
    </div>
  );
}

type Parts = { name: string; askInChat: (draft: string) => void; renderMarkdown: (markdown: string) => ReactNode; t: T };

function BriefButton({ name, askInChat, t }: Parts) {
  return (
    <button type="button" className="ta-card ta-today-brief" onClick={() => askInChat(t('today.prompt'))} data-testid="assistant-today-brief">
      <span className="ta-tile-icon">
        <Sun />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
        <span className="ta-tile-title">{t('today.latestBrief')}</span>
        <span className="ta-tile-sub">{t('today.latestBriefNote', { name })}</span>
      </span>
      <Sparkles className="ta-banner-icon" />
    </button>
  );
}

/** 小组件:一张 = 它到点重写的一段 markdown;没有就是空态。「添加组件」打开「发现组件」。 */
function Widgets({ widgets, onAdd, name, askInChat, renderMarkdown, t }: Parts & { widgets: TodayWidget[]; onAdd: () => void }) {
  const add = (
    <button type="button" className="ta-pill-btn" onClick={onAdd} data-testid="assistant-today-widget">
      {t('today.addWidget')}
    </button>
  );
  if (widgets.length === 0) {
    return (
      <AssistantSection title={t('today.widgets')} bare testId="assistant-today-widgets">
        <div className="ta-card ta-empty">
          <span className="ta-tile-icon">
            <LayoutGrid />
          </span>
          <span className="ta-empty-title">{t('today.widgetsEmptyTitle')}</span>
          <span>{t('today.widgetsEmpty', { name })}</span>
          {add}
        </div>
      </AssistantSection>
    );
  }
  return (
    <AssistantSection title={t('today.widgets')} action={add} bare testId="assistant-today-widgets">
      <div className="ta-grid">
        {widgets.map((widget) => (
          <WidgetCard key={widget.id} widget={widget} askInChat={askInChat} renderMarkdown={renderMarkdown} t={t} />
        ))}
      </div>
    </AssistantSection>
  );
}

/**
 * 一张小组件的一生:它正在写第一版 =「正在为你生成…」;没写成 =「卡片生成失败」+ 让它再试;
 * 写好了 = 正文 + 更新于 / 它排的节奏。右上「…」:立即更新 / 修改 / 删除 —— 都只往聊天里填一句(人按发送那一下就是确认)。
 */
function WidgetCard({ widget, askInChat, renderMarkdown, t }: Omit<Parts, 'name'> & { widget: TodayWidget }) {
  const title = widget.title;
  const foot = [widget.updatedAt ? t('today.widgetUpdated', { time: clock(widget.updatedAt) }) : null, widget.schedule].filter(Boolean).join(' · ');
  return (
    <div className="ta-card ta-today-widget" data-state={widget.state} data-testid={`assistant-today-widget-${widget.id}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="ta-tile-title">{title}</span>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger className="ta-widget-more" aria-label={t('today.widget.more', { title })} data-testid={`assistant-widget-menu-${widget.id}`}>
            <MoreHorizontal />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content data-ta-menu="" side="bottom" align="end" sideOffset={6}>
            <MenuItem icon={<RefreshCw />} disabled={widget.state === 'creating'} onClick={() => askInChat(t('today.widget.refreshPrompt', { title }))}>
              {t('today.widget.refresh')}
            </MenuItem>
            <MenuItem icon={<Pencil />} disabled={widget.state === 'creating'} onClick={() => askInChat(t('today.widget.editPrompt', { title }))}>
              {t('today.widget.edit')}
            </MenuItem>
            <MenuItem icon={<Trash2 />} danger onClick={() => askInChat(t('today.widget.deletePrompt', { title }))}>
              {t('today.widget.delete')}
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      {widget.state === 'creating' ? (
        <span className="ta-tile-sub inline-flex items-center gap-2" data-testid={`assistant-widget-creating-${widget.id}`}>
          <LoadingIndicator size="inline" />
          {t('today.widget.creating', { title })}
        </span>
      ) : widget.state === 'failed' ? (
        <div className="flex flex-col gap-2" data-testid={`assistant-widget-failed-${widget.id}`}>
          <span className="ta-tile-sub">{t('today.widget.failed')}</span>
          <div>
            <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('today.widget.retryPrompt', { title }))}>
              {t('today.widget.retry')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="ta-prose">{renderMarkdown(widget.markdown)}</div>
          {foot ? <span className="ta-tile-sub">{foot}</span> : null}
        </>
      )}
    </div>
  );
}

function BatchCards({ batch, name, askInChat, renderMarkdown, t }: Parts & { batch: TodayBatch }) {
  if (batch.cards.length === 0) {
    return <div className="ta-card ta-page-sub">{t('today.inChat', { name })}</div>;
  }
  return (
    <div className="ta-today-cards">
      {batch.cards.map((card) => (
        <div key={card.id} className="ta-card ta-today-card" data-testid={`assistant-today-card-${card.id}`}>
          <span className="ta-tile-title">{card.title}</span>
          {card.markdown ? <div className="ta-prose">{renderMarkdown(card.markdown)}</div> : null}
          <div>
            <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('today.askPrompt', { title: card.title }))}>
              {t('today.ask', { name })}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 段头的日期:今天 / 昨天 / 10月13日 · 星期一(按这台设备的日历日)。 */
function dateLabel(localDate: string, now: Date, t: T): string {
  const which = dayOf(localDate, now);
  if (which !== 'other') return t(`today.day.${which}`);
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = new Intl.DateTimeFormat(t('today.locale'), { weekday: 'long' }).format(date);
  return t('today.date', { month, day, weekday });
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 读不到时文案只给下一步:登录失效 / 不是文本 / 稍后重试(原因在上面进了日志)。 */
function unreadableCopy(t: T, error: unknown, name: string): string {
  const kind = error instanceof TodayReadError ? error.kind : 'unknown';
  if (kind === 'signed-out') return t('today.unreadableSignedOut');
  if (kind === 'not-text') return t('today.unreadableNotText', { name });
  return t('today.unreadable');
}
