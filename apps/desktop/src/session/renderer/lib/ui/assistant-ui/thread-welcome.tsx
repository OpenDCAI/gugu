/**
 * Vendored from assistant-ui Elements（`thread.tsx` 的 `ThreadWelcome` / `ThreadSuggestions`
 * / `ThreadSuggestionItem`）。
 *
 * 上游三者都读 runtime:`AuiIf(isNewChatView)` 决定空态、`SuggestionPrimitive.Trigger send`
 * 负责发送。这里全部换成 props 进、回调出 —— 咕咕已有 `AcpChatStore` 这一份真相,
 * 不再接第二份(理由见本目录 README)。
 *
 * 字阶与圆角按本仓视觉规格收敛(上游是 `text-2xl` / `rounded-full`),见 README 的逐条改动表。
 */
import type { FC, ReactNode } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';

export type ThreadSuggestion = {
  id: string;
  /** 芯片上的短标题。 */
  title: string;
  /** 真正会被提交的文案 —— 与 title 分开,因为提示词库的正文常常是多行。 */
  prompt: string;
};

export type ThreadWelcomeProps = {
  title: ReactNode;
  suggestions?: ThreadSuggestion[];
  /** 点击建议芯片。宿主负责真的把它提交出去 —— 这里不做占位按钮。 */
  onSelectSuggestion?: (suggestion: ThreadSuggestion) => void;
  /** 建议区的无障碍名字(宿主提供已翻译文案)。 */
  suggestionsLabel?: string;
  className?: string;
};

export const ThreadWelcome: FC<ThreadWelcomeProps> = ({
  title,
  suggestions,
  onSelectSuggestion,
  suggestionsLabel,
  className,
}) => (
  <div
    data-slot="aui-thread-welcome"
    className={cn('flex flex-col items-center gap-4 px-4 text-center', className)}
  >
    <h1 className="gg-type-page-title animate-in text-foreground duration-[var(--dur-med,180ms)] fade-in slide-in-from-bottom-1 fill-mode-both">
      {title}
    </h1>
    {suggestions && suggestions.length > 0 && onSelectSuggestion ? (
      <div
        data-slot="aui-thread-welcome-suggestions"
        aria-label={suggestionsLabel}
        className="animate-in flex w-full flex-wrap items-center justify-center gap-2 duration-[var(--dur-med,180ms)] fade-in slide-in-from-bottom-2 fill-mode-both"
      >
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion.id}
            type="button"
            variant="ghost"
            // ❌ 别再补 `border-border/60`:ghost 的基础态是 border-transparent,补上去 chip 就从
            // 「安静的文字项」变回一排描边小盒子(design.md 拒绝 icon suggestion chips 那套聊天套路)。
            className="h-auto max-w-full px-3 py-1 text-sm font-normal text-foreground"
            onClick={() => onSelectSuggestion(suggestion)}
          >
            <span className="truncate">{suggestion.title}</span>
          </Button>
        ))}
      </div>
    ) : null}
  </div>
);
