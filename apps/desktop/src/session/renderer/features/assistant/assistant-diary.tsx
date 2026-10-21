import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { diaryBatches, diaryMonths, diaryPreview, type TodayBatch } from './assistant-today-file';
import type { TodayFeedView } from './assistant-today-feed';
import { AssistantEmpty, AssistantSection, PageHead } from './assistant-ui-parts';

/**
 * #7199「<它的名字>」那一格的日记:它写在 today.json 里 kind = diary 的那几批 —— 与「动态」页信息流同一份、
 * 同一个读法(桌面主进程读 / 手机窗口里 fetch,各自给 `view`),桌面与手机壳共用这一份画法。
 * - 资料页上:最近几篇两列小卡(小日历:星期 + 几号;日期;一段预览),多了给「全部日记」;
 * - 全部日记:按月分组;
 * - 点一篇:全文(它写的几段)+「和它聊聊这篇」(只往聊天里填一句)。
 * 读不到 / 读不懂如实说,❌ 当成「还没有日记」。
 */

type DiaryBase = { view: TodayFeedView; name: string; askInChat: (draft: string) => void };
type T = ReturnType<typeof useTranslation<'assistant'>>['t'];

/** 读到的日记;还没读到 / 读不到 / 读不懂 = 那一种情形要画的东西。 */
function useDiaries(view: TodayFeedView, name: string, askInChat: (draft: string) => void): { diaries: TodayBatch[] } | { fallback: ReactNode } {
  const { t } = useTranslation('assistant');
  if (view.state === 'loading')
    return {
      fallback: (
        <AssistantEmpty>
          <span className="inline-flex items-center gap-2">
            <LoadingIndicator size="inline" />
            {t('diary.loading')}
          </span>
        </AssistantEmpty>
      ),
    };
  if (view.state === 'error')
    return {
      fallback: (
        <AssistantEmpty
          action={
            <button type="button" className="ta-pill-btn" onClick={view.retry}>
              {t('machine.retry')}
            </button>
          }
        >
          {t('diary.unreadable')}
        </AssistantEmpty>
      ),
    };
  const read = view.read;
  if (read.state === 'invalid')
    return {
      fallback: (
        <AssistantEmpty
          action={
            <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('today.fixPrompt', { problem: read.problem }))}>
              {t('today.fix', { name })}
            </button>
          }
        >
          {t('today.invalid', { name, problem: read.problem })}
        </AssistantEmpty>
      ),
    };
  return { diaries: read.state === 'ok' ? diaryBatches(read.file) : [] };
}

function DiaryEmpty({ name, askInChat }: { name: string; askInChat: (draft: string) => void }) {
  const { t } = useTranslation('assistant');
  return (
    <AssistantEmpty
      title={t('diary.emptyTitle')}
      action={
        <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('diary.prompt'))}>
          <BookOpen />
          {t('diary.ask', { name })}
        </button>
      }
    >
      {t('diary.empty', { name })}
    </AssistantEmpty>
  );
}

function dateOf(localDate: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function DiaryTile({ batch, name, onOpen, t }: { batch: TodayBatch; name: string; onOpen: () => void; t: T }) {
  const date = dateOf(batch.localDate);
  const locale = t('today.locale');
  const preview = diaryPreview(batch);
  return (
    <button type="button" className="ta-tile ta-diary-tile" onClick={onOpen} data-testid={`assistant-diary-${batch.id}`}>
      <span className="ta-diary-day" aria-hidden>
        <span className="ta-diary-weekday">{new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)}</span>
        <span className="ta-diary-date">{date.getDate()}</span>
      </span>
      <span className="ta-tile-title">{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(date)}</span>
      <span className="ta-diary-preview">{preview || t('today.inChat', { name })}</span>
    </button>
  );
}

/** 资料页上那一段:最近 `limit` 篇;多了给「全部日记」。 */
export function AssistantDiarySection({ view, name, askInChat, open, openAll, limit = 4 }: DiaryBase & { open: (id: string) => void; openAll: () => void; limit?: number }) {
  const { t } = useTranslation('assistant');
  const state = useDiaries(view, name, askInChat);
  const diaries = 'diaries' in state ? state.diaries : [];
  const more = diaries.length > limit;
  return (
    <AssistantSection
      title={t('diary.title')}
      action={
        more ? (
          <button type="button" className="ta-pill-btn" onClick={openAll} data-testid="assistant-diary-all">
            {t('diary.all', { count: diaries.length })}
          </button>
        ) : undefined
      }
      bare
      testId="assistant-diaries"
    >
      {'fallback' in state ? (
        <div className="ta-card">{state.fallback}</div>
      ) : diaries.length === 0 ? (
        <div className="ta-card">
          <DiaryEmpty name={name} askInChat={askInChat} />
        </div>
      ) : (
        <div className="ta-grid">
          {diaries.slice(0, limit).map((batch) => (
            <DiaryTile key={batch.id} batch={batch} name={name} onOpen={() => open(batch.id)} t={t} />
          ))}
        </div>
      )}
    </AssistantSection>
  );
}

/** 全部日记:按月分组(2026年10月 / 2026年9月……)。 */
export function AssistantDiaryList({ view, name, askInChat, open }: DiaryBase & { open: (id: string) => void }) {
  const { t } = useTranslation('assistant');
  const state = useDiaries(view, name, askInChat);
  const locale = t('today.locale');
  return (
    <div className="ta-page" data-testid="assistant-diary-list">
      <PageHead title={t('diary.title')} sub={t('diary.listSub', { name })} />
      {'fallback' in state ? (
        state.fallback
      ) : state.diaries.length === 0 ? (
        <DiaryEmpty name={name} askInChat={askInChat} />
      ) : (
        diaryMonths(state.diaries).map((month) => (
          <AssistantSection
            key={month.key}
            title={new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(month.year, month.month - 1, 1))}
            bare
            testId={`assistant-diary-month-${month.key}`}
          >
            <div className="ta-grid">
              {month.batches.map((batch) => (
                <DiaryTile key={batch.id} batch={batch} name={name} onOpen={() => open(batch.id)} t={t} />
              ))}
            </div>
          </AssistantSection>
        ))
      )}
    </div>
  );
}

/** 一篇:它写的几段全文;没有正文 = 正文在聊天里。 */
export function AssistantDiaryDetail({ view, name, askInChat, id, renderMarkdown }: DiaryBase & { id: string; renderMarkdown: (markdown: string) => ReactNode }) {
  const { t } = useTranslation('assistant');
  const state = useDiaries(view, name, askInChat);
  if ('fallback' in state) return <div className="ta-page">{state.fallback}</div>;
  const batch = state.diaries.find((diary) => diary.id === id) ?? null;
  if (!batch)
    return (
      <div className="ta-page" data-testid="assistant-diary-gone">
        <AssistantEmpty title={t('diary.goneTitle')}>{t('diary.gone', { name })}</AssistantEmpty>
      </div>
    );
  const date = dateOf(batch.localDate);
  const title = new Intl.DateTimeFormat(t('today.locale'), { month: 'long', day: 'numeric', weekday: 'long' }).format(date);
  return (
    <div className="ta-page" data-testid="assistant-diary-detail">
      <PageHead title={title} sub={t('diary.of', { name })} />
      {batch.cards.length === 0 ? (
        <div className="ta-card ta-page-sub">{t('today.inChat', { name })}</div>
      ) : (
        batch.cards.map((card) => (
          <div key={card.id} className="ta-card ta-today-card" data-testid={`assistant-diary-card-${card.id}`}>
            <span className="ta-tile-title">{card.title}</span>
            {card.markdown ? <div className="ta-prose">{renderMarkdown(card.markdown)}</div> : null}
          </div>
        ))
      )}
      <div>
        <button type="button" className="ta-pill-btn" onClick={() => askInChat(t('diary.talkPrompt', { date: title }))} data-testid="assistant-diary-talk">
          <BookOpen />
          {t('diary.talk', { name })}
        </button>
      </div>
    </div>
  );
}
