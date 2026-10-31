import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { setIdeasEntryHidden, subscribeIdeasRequest, useIdeasEntryHidden } from '@/lib/assistantIdeas';
import { Eye, EyeOff, Lightbulb, Sparkles, X } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { ideaGroups, type TodayIdea } from './assistant-today-file';
import type { TodayFeedView } from './assistant-today-feed';
import { AssistantEmpty } from './assistant-ui-parts';

/**
 * #7199 「灵感」:输入框右上方一颗「灵感」胶囊,点开一块面板,一张卡 = 一件它现在就能替你做的事,
 * 点一张 = 把那句话接进输入框(只填不发)。内容是它按对你的了解写在 today.json 的 ideas 里的(❌ 写死一份):
 * 没写 = 空态 +「让它想几个」;读不到 / 这一块读不懂如实说。
 * 胶囊能隐藏(面板左上那颗开关,隐藏先确认),隐藏后「+」里的「获取灵感」照样在(lib/assistantIdeas.ts)。
 * 桌面包一层对话框、手机盖一层整页,里面这一份共用;胶囊与自定义入口在两边共用输入框上方的一行。
 */

/** 「+」里点了「获取灵感」:面板那一侧打开。 */
export function useIdeasOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeIdeasRequest(() => setOpen(true)), []);
  return [open, setOpen];
}

/** Composer-row entry; hidden and recording states consume no space. */
export function IdeasEntry({ assistantId, busy, onOpen }: { assistantId: string; busy: boolean; onOpen: () => void }) {
  const { t } = useTranslation('assistant');
  const hidden = useIdeasEntryHidden(assistantId);
  if (hidden || busy) return null;
  return (
    <button type="button" className="ta-ideas-pill" onClick={onOpen} data-testid="assistant-ideas-entry">
      <Sparkles />
      {t('ideas.title')}
    </button>
  );
}

export function IdeasPanel({
  view,
  assistantId,
  name,
  askInChat,
  onClose,
  layout,
}: {
  view: TodayFeedView;
  assistantId: string;
  name: string;
  askInChat: (draft: string) => void;
  onClose: () => void;
  layout: 'dialog' | 'page';
}) {
  const { t } = useTranslation('assistant');
  const hidden = useIdeasEntryHidden(assistantId);
  const [confirming, setConfirming] = useState(false);
  const fill = (draft: string) => {
    onClose();
    askInChat(draft);
  };
  return (
    <div className="ta-ideas" data-layout={layout} data-testid="assistant-ideas">
      <div className="ta-ideas-head">
        <button
          type="button"
          className="ta-pill-btn"
          onClick={() => (hidden ? setIdeasEntryHidden(assistantId, false) : setConfirming(true))}
          data-testid="assistant-ideas-toggle"
        >
          {hidden ? <Eye /> : <EyeOff />}
          {hidden ? t('ideas.show') : t('ideas.hide')}
        </button>
        <h2 className="ta-dialog-title">{t('ideas.title')}</h2>
        <button type="button" className="ta-circle" aria-label={t('ideas.close')} onClick={onClose} data-testid="assistant-ideas-close">
          <X />
        </button>
      </div>
      {confirming ? (
        <div className="ta-card ta-ideas-confirm" role="alertdialog" aria-label={t('ideas.hideTitle')} data-testid="assistant-ideas-confirm">
          <span className="ta-tile-title">{t('ideas.hideTitle')}</span>
          <span className="ta-tile-sub">{t('ideas.hideBody')}</span>
          <div className="flex justify-end gap-2">
            <button type="button" className="ta-pill-btn" onClick={() => setConfirming(false)}>
              {t('ideas.cancel')}
            </button>
            <button
              type="button"
              className="ta-pill-btn"
              data-tone="danger"
              onClick={() => {
                setIdeasEntryHidden(assistantId, true);
                setConfirming(false);
              }}
              data-testid="assistant-ideas-hide-confirm"
            >
              {t('ideas.hide')}
            </button>
          </div>
        </div>
      ) : null}
      <IdeasBody view={view} name={name} fill={fill} />
    </div>
  );
}

function IdeasBody({ view, name, fill }: { view: TodayFeedView; name: string; fill: (draft: string) => void }) {
  const { t } = useTranslation('assistant');
  const note = (body: ReactNode, action?: { label: string; draft: string }, testId?: string) => (
    <div className="ta-card" data-testid={testId}>
      <AssistantEmpty
        action={
          action ? (
            <button type="button" className="ta-pill-btn" onClick={() => fill(action.draft)}>
              {action.label}
            </button>
          ) : undefined
        }
      >
        {body}
      </AssistantEmpty>
    </div>
  );
  if (view.state === 'loading')
    return note(
      <span className="inline-flex items-center gap-2">
        <LoadingIndicator size="inline" />
        {t('ideas.loading')}
      </span>
    );
  if (view.state === 'error')
    return (
      <div className="ta-card" data-testid="assistant-ideas-unreadable">
        <AssistantEmpty
          action={
            <button type="button" className="ta-pill-btn" onClick={view.retry}>
              {t('machine.retry')}
            </button>
          }
        >
          {t('ideas.unreadable')}
        </AssistantEmpty>
      </div>
    );
  const read = view.read;
  if (read.state === 'invalid') return note(t('today.invalid', { name, problem: read.problem }), { label: t('today.fix', { name }), draft: t('today.fixPrompt', { problem: read.problem }) }, 'assistant-ideas-invalid');
  const part = read.state === 'ok' ? read.file.ideas : ({ state: 'none' } as const);
  if (part.state === 'invalid')
    return note(t('ideas.invalid', { name, problem: part.problem }), { label: t('today.fix', { name }), draft: t('today.fixPrompt', { problem: part.problem }) }, 'assistant-ideas-invalid');
  const items = part.state === 'ok' ? part.value.items : [];
  if (items.length === 0)
    return note(
      <span className="ta-empty-title">{t('ideas.empty')}</span>,
      { label: t('ideas.ask', { name }), draft: t('ideas.askPrompt') },
      'assistant-ideas-empty'
    );
  return (
    <div className="ta-ideas-groups">
      {ideaGroups(items).map((group) => (
        <section key={group.label ?? ''} className="ta-section">
          {group.label ? <h3 className="ta-section-title">{group.label}</h3> : null}
          <div className="ta-ideas-grid">
            {group.items.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} onPick={() => fill(idea.prompt)} />
            ))}
          </div>
        </section>
      ))}
      <div className="flex justify-center">
        <button type="button" className="ta-pill-btn" onClick={() => fill(t('ideas.morePrompt'))} data-testid="assistant-ideas-more">
          <Sparkles />
          {t('ideas.more', { name })}
        </button>
      </div>
    </div>
  );
}

function IdeaCard({ idea, onPick }: { idea: TodayIdea; onPick: () => void }) {
  return (
    <button type="button" className="ta-tile ta-idea" onClick={onPick} data-testid={`assistant-idea-${idea.id}`}>
      <span className="ta-idea-emoji" aria-hidden>
        {idea.emoji ?? <Lightbulb />}
      </span>
      <span className="ta-idea-title">{idea.title}</span>
      {idea.description ? <span className="ta-idea-body">{idea.description}</span> : null}
    </button>
  );
}
