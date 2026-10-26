import type { ReactNode } from 'react';
import { ChevronRight } from '@/lib/icons';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/Avatar';

// #7199 「助理」App 的页面元件(类名见 assistant-today.css):页头、分段、一段标题 + 一张卡、
// 卡里的行、两列的小卡、空态。各页只拼这些,❌ 各写各的圆角与间距。
// 这一份不碰会话页的状态(桌面「助理」视图与手机壳里的助理 App 共用);要读云电脑的 MachineGate 在 assistant-ui.tsx。

/** 页头:大标题(可带一句说明),右边一个动作(「任务 / + 创建任务」「记忆 / +」)。 */
export function PageHead({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ta-page-head">
      <div className="min-w-0">
        <h1 className="ta-page-title">{title}</h1>
        {sub ? <p className="ta-page-sub">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** 页里的一整条分段(任务页的「任务 | 定时任务」)。 */
export function WideSegments<K extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly { id: K; label: string; icon?: ReactNode }[];
  value: K;
  onChange: (id: K) => void;
}) {
  return (
    <div className="ta-seg-wide" role="tablist">
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)} data-testid={`assistant-seg-${item.id}`}>
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 一段:标题在卡外面(「今天 / 更早 / 进行中」),下面一张卡装行;`bare` = 内容自己排(网格、大卡)。 */
export function AssistantSection({
  title,
  note,
  action,
  children,
  testId,
  bare,
}: {
  title?: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
  bare?: boolean;
}) {
  return (
    <section className="ta-section" data-testid={testId}>
      {title || action ? (
        <div className="flex items-center justify-between gap-3">
          {title ? <h2 className="ta-section-title">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {note ? <p className="ta-page-sub ta-pad">{note}</p> : null}
      {bare ? children : <div className="ta-card-list">{children}</div>}
    </section>
  );
}

/** 卡里的一行:左边图标,中间两行字,右边状态;整行可点时右边一个 ›。 */
export function AssistantRow({
  leading,
  title,
  detail,
  trailing,
  onClick,
  testId,
  chevron = true,
}: {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  testId?: string;
  chevron?: boolean;
}) {
  const body = (
    <>
      {leading ? <span className="flex size-9 shrink-0 items-center justify-center">{leading}</span> : null}
      <span className="ta-row-body">
        <span className="ta-row-title">{title}</span>
        {detail ? <span className="ta-row-sub">{detail}</span> : null}
      </span>
      {trailing ? <span className="ta-row-meta">{trailing}</span> : null}
      {onClick && chevron ? (
        <span className="ta-row-chevron">
          <ChevronRight />
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} data-testid={testId} className="ta-row" data-divided={leading ? undefined : ''}>
      {body}
    </button>
  ) : (
    <div className="ta-row" data-testid={testId} data-divided={leading ? undefined : ''}>
      {body}
    </div>
  );
}

/** 主人(登录的那个人)。 */
export type AssistantOwner = { id: string; name: string; avatarUrl: string | null };

/** 「关于你」那几行的行首:主人自己的头像(照个人介绍的通行做法:本人头像 + 标题 + 一句话)。认不出主人就不放行首,❌ 皇冠之类的装饰图标顶上。 */
export function ownerLeading(owner: AssistantOwner | null | undefined): ReactNode {
  return owner ? <Avatar name={owner.name} avatarUrl={owner.avatarUrl} seed={owner.id} size={36} /> : undefined;
}

/** 两列网格里的一张小卡(记忆「全部」:文件夹、录音笔记、一条记忆)。 */
export function Tile({
  icon,
  title,
  sub,
  preview,
  onClick,
  testId,
}: {
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  preview?: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button type="button" className="ta-tile" onClick={onClick} data-testid={testId}>
      {icon ? <span className="ta-tile-icon">{icon}</span> : null}
      <span className={cn('ta-tile-title', icon && 'mt-auto')}>{title}</span>
      {sub ? <span className="ta-tile-sub">{sub}</span> : null}
      {preview ? <span className="ta-tile-preview">{preview}</span> : null}
    </button>
  );
}

/** 没东西、或还读不到时那一块字(空态:居中、一句标题一句说明、一个动作)。 */
export function AssistantEmpty({ title, children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ta-empty">
      {title ? <span className="ta-empty-title">{title}</span> : null}
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}

export function StatusPill({ tone, children }: { tone: 'on' | 'off' | 'muted'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-1 text-xs',
        tone === 'on' && 'bg-background-success text-foreground-success',
        tone === 'off' && 'ta-chip-off',
        tone === 'muted' && 'text-foreground-muted'
      )}
    >
      {children}
    </span>
  );
}
