import { Clock, Sparkles, X } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ComposerVerbLook } from './session-config/initial-session-section';

const TAG_TONE = {
  task: 'bg-(--em-foreground-conflict)/12 text-[var(--em-foreground-conflict)]',
  schedule: 'bg-[var(--em-background-info)] text-[var(--em-foreground-info)]',
} as const;

/**
 * gugu-dev#181「输入框」:框此刻是一件事时,输入行最前面那枚标签(「新任务 ×」「定时任务 ×」),框也跟着换成那件事的色。
 * 群里的框、项目首页的框、新任务 / 定时任务的框都用这一个;`onCancel` 缺省 = 不带 ×(项目首页本来就只能开新任务)。
 */
export function composerVerbLook(
  tone: ComposerVerbLook['tone'],
  { label, onCancel, testId }: { label: string; onCancel?: () => void; /** 标签 `<testId>-verb`,× 是 `<testId>-cancel`。 */ testId?: string },
): ComposerVerbLook {
  return { tone, tag: <ComposerVerbTag tone={tone} label={label} onCancel={onCancel} testId={testId} /> };
}

function ComposerVerbTag({ tone, label, onCancel, testId }: {
  tone: ComposerVerbLook['tone'];
  label: string;
  onCancel?: () => void;
  testId?: string;
}) {
  const { translate } = useSessionMessages();
  const Icon = tone === 'task' ? Sparkles : Clock;
  return (
    <span
      data-testid={testId ? `${testId}-verb` : undefined}
      className={cn('inline-flex h-6 items-center gap-1 rounded-full pl-2 text-xs whitespace-nowrap', onCancel ? 'pr-1' : 'pr-2', TAG_TONE[tone])}
    >
      <Icon className="size-3 shrink-0" />
      <span>{label}</span>
      {onCancel ? (
        <button
          type="button"
          aria-label={translate('taskDispatch.cancel')}
          title={translate('taskDispatch.cancel')}
          onClick={onCancel}
          className="grid size-4 place-items-center rounded-full opacity-70 hover:opacity-100"
          data-testid={testId ? `${testId}-cancel` : undefined}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}
