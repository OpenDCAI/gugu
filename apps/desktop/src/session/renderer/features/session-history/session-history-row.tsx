import { Fragment } from 'react';
import { formatCalendarDate } from '@/i18n/format';
import type { SessionImportSource } from '@renderer/features/session-import/import-source';
import { SessionPreviewPane } from '@renderer/features/session-import/session-preview-pane';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { cn } from '@renderer/utils/utils';
import { LOCAL_SESSION_ENGINE_LABEL } from '@shared/core/session-import/session-import';
import {
  displaySessionTitle,
  type SessionHistoryRow as SessionHistoryRowData,
  type SessionHistorySource,
  type SessionHistoryStatus,
} from '@shared/core/session-history/session-history';

export const STATUS_MESSAGE_KEY: Record<SessionHistoryStatus, SessionMessageKey> = {
  active: 'sessionHistory.statusActive',
  archived: 'sessionHistory.statusArchived',
  'not-imported': 'sessionHistory.statusNotImported',
};

/** 行上的动作按状态定(spec session-page「会话历史」):活跃 → 打开;已归档 → 恢复;未导入 → 导入(沿用导入管道,导完直接进对话)。 */
export const ACTION_MESSAGE_KEY: Record<SessionHistoryStatus, SessionMessageKey> = {
  active: 'sessionHistory.open',
  archived: 'sessionHistory.restore',
  'not-imported': 'sessionHistory.import',
};

/** 「咕咕」是本域 chrome、要本地化;引擎名是 provider 品牌常量,两种语言下逐字相同。 */
export function sourceLabel(
  source: SessionHistorySource,
  translate: (key: SessionMessageKey) => string
): string {
  return source === 'gugu' ? translate('sessionHistory.sourceGugu') : LOCAL_SESSION_ENGINE_LABEL[source];
}

export function historyOptionId(key: string): string {
  return `session-history-option-${key}`;
}

/** 咕咕行的详情(本机行的详情是原件预览 SessionPreviewPane)。 */
function GuguDetail({ row }: { row: SessionHistoryRowData }) {
  const { translate } = useSessionMessages();
  const lines: Array<[SessionMessageKey, React.ReactNode]> = [
    ['sessionHistory.detailStatus', translate(STATUS_MESSAGE_KEY[row.status])],
    [
      'sessionHistory.detailSessionId',
      <span key="id" className="font-mono">
        {row.providerSessionId ?? row.gugu?.sessionId ?? ''}
      </span>,
    ],
    ['sessionHistory.detailProject', row.projectName ?? translate('sessionHistory.groupUnprojected')],
    ['sessionHistory.detailDirectory', row.directory ?? translate('sessionImport.unknownDirectory')],
    ['sessionHistory.detailUpdated', <RelativeTime key="u" value={row.updatedAt} />],
    ['sessionHistory.detailLastPrompt', row.lastPromptAt ? <RelativeTime key="p" value={row.lastPromptAt} /> : null],
    ['sessionHistory.detailAdded', row.addedAt ? <RelativeTime key="a" value={row.addedAt} /> : null],
  ];
  if (row.archivedAt) lines.push(['sessionHistory.detailArchived', <RelativeTime key="r" value={row.archivedAt} />]);
  return (
    <div className="flex flex-col gap-2 p-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {lines.map(([key, value]) => (
          <Fragment key={key}>
            <dt className="text-foreground-tertiary-muted">{translate(key)}</dt>
            <dd className={cn('min-w-0 break-all text-foreground-muted', key === 'sessionHistory.detailDirectory' && row.directory && 'font-mono')}>
              {value}
            </dd>
          </Fragment>
        ))}
      </dl>
      {/* 父子范围要说得出(#6083 坑 ④):恢复只恢复这一条,挂在它下面的子会话各自是一行、各自恢复。 */}
      {row.childCount > 0 ? (
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionHistory.childScope', { count: row.childCount })}
        </p>
      ) : null}
      {row.parentTitle ? (
        <p className="text-xs leading-relaxed text-foreground-tertiary-muted">
          {translate('sessionHistory.parentOf', { title: displaySessionTitle(row.parentTitle) })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 一条 = 两行 + 右侧一个动作,几何照 设计同事 2026-09-23 的模板图(「已归档的聊天」)逐项量出来:
 * 行高 60px(min-h-15)、左右 16px、标题 13px 正文色、第二行只有时间(13px 次级色)(模板写法「2026年8月20日，19:46」)、
 * 右侧浅灰实心按钮 h-7。行与行之间**不画线**,靠行高节奏与悬停填色分开(docs/design/ui-visual-spec.md §6.6;
 * design.md line budget:「Rows breathe on rhythm and a hover fill, not on dividers」—— 设计同事 2026-09-25)。
 * 状态不另贴标签 —— 动作钮本身就说了(打开 / 恢复 / 导入);session id、agent、父子范围都在详情里,
 * 行上不放(模板行上只有标题与时间)。批量导入在节头 ···,行上不放勾选框。
 */
export function SessionHistoryRow({
  row,
  isSelected,
  isHighlighted,
  isExpanded,
  onSelect,
  onAction,
  previewSource,
  describePreviewError,
}: {
  row: SessionHistoryRowData;
  /** 光标:键盘上下移动的那一行。 */
  isSelected: boolean;
  /** 选中底色:只给用户自己点过 / 键盘走到的那一行 —— 光标的缺省落点(第一行)不上色,页面上不常驻一块 live 蓝。 */
  isHighlighted: boolean;
  /** 详情展开在这条下面(本机行 = 原件预览,咕咕行 = 详情)。 */
  isExpanded: boolean;
  onSelect: () => void;
  onAction: () => void;
  /** #6264 原件在哪台机器上:预览问那一台。 */
  previewSource: SessionImportSource;
  describePreviewError: (error: unknown) => string;
}) {
  const { translate, locale } = useSessionMessages();
  const title = row.title || translate('sessionHistory.untitled');
  return (
    <div data-testid="session-history-item">
      <div
        id={historyOptionId(row.key)}
        role="option"
        aria-selected={isSelected}
        tabIndex={-1}
        data-testid="session-history-row"
        data-row-key={row.key}
        data-source={row.source}
        data-status={row.status}
        onClick={onSelect}
        className={cn(
          '-mx-4 flex min-h-15 cursor-default items-center gap-3 px-4 py-2 transition-colors hover:bg-row-hover active:bg-row-press motion-reduce:transition-none',
          isHighlighted && 'bg-row-selected'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm leading-5', row.title ? 'text-foreground' : 'text-foreground-muted')} title={title}>
            {title}
          </div>
          <time
            className="block truncate text-sm leading-5 text-foreground-muted tabular-nums"
            dateTime={new Date(row.updatedAt).toISOString()}
          >
            {/* 绝对时间、年份总写:列表里一眼要能比先后。 */}
            {formatCalendarDate(row.updatedAt, locale, { includeYear: true })}
          </time>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] active:bg-foreground/[0.14]"
          data-testid="session-history-action"
          onClick={(event) => {
            event.stopPropagation();
            onAction();
          }}
        >
          {translate(ACTION_MESSAGE_KEY[row.status])}
        </Button>
      </div>
      {isExpanded ? (
        <div data-testid="session-history-detail" className="-mx-4 bg-foreground/[0.025]">
          <div className="max-h-72 overflow-y-auto">
            {row.local ? (
              <SessionPreviewPane session={row.local} source={previewSource} describeError={describePreviewError} />
            ) : (
              <GuguDetail row={row} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
