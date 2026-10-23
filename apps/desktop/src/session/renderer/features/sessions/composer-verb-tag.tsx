import { X } from '@/lib/icons';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import { cn } from '@renderer/utils/utils';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ComposerVerbLook } from './session-config/initial-session-section';
import { composerDrafts } from './composer-drafts';

const TAG_TONE = {
  task: 'bg-(--em-foreground-conflict)/12 text-[var(--em-foreground-conflict)]',
} as const;

/**
 * gugu-dev#181「输入框」:框此刻是一件事时,输入行最前面那枚标签(「新任务 ×」),框也跟着换成那件事的色。
 * 群里的框、项目首页的框、新任务的框都用这一个;`onCancel` 缺省 = 不带 ×(项目首页本来就只能开新任务)。
 */
/**
 * 点了标签上的 ×:框还原成发消息,这一框里写了的话交回去(composerVerbBridge 的 carry,发消息的框取走),
 * 这一格草稿清掉 —— ❌ 字留在新任务的草稿里、下次打开才冒出来。发出去之后收框不走这里(草稿已经清了,也没有话要交回)。
 */
export function cancelComposerVerb(verbKey: string, draftKey: string): void {
  const text = composerDrafts.get(draftKey);
  composerDrafts.set(draftKey, '');
  setComposerVerb(verbKey, null, text);
}

export function composerVerbLook(
  tone: ComposerVerbLook['tone'],
  { label, onCancel, testId }: { label: string; onCancel?: () => void; /** 标签 `<testId>-verb`,× 是 `<testId>-cancel`。 */ testId?: string },
): ComposerVerbLook {
  return { tone, tag: (agentId) => <ComposerVerbTag tone={tone} agentId={agentId} label={label} onCancel={onCancel} testId={testId} /> };
}

function ComposerVerbTag({ tone, agentId, label, onCancel, testId }: {
  tone: ComposerVerbLook['tone'];
  /** 所选 agent 的标(与任务卡卡头、按钮上的同一枚)。 */
  agentId: string | undefined;
  label: string;
  onCancel?: () => void;
  testId?: string;
}) {
  const { translate } = useSessionMessages();
  return (
    <span
      data-testid={testId ? `${testId}-verb` : undefined}
      className={cn('inline-flex h-6 items-center gap-1 rounded-full pl-2 text-xs whitespace-nowrap', onCancel ? 'pr-1' : 'pr-2', TAG_TONE[tone])}
    >
      {agentId ? <AgentIcon id={agentId} size={12} /> : null}
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
