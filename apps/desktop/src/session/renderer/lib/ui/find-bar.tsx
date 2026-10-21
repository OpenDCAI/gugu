import { ChevronDown, ChevronUp, Search, X } from '@/lib/icons'
import React, { type RefObject } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import type { FindStatus } from './use-find-bar';

interface Props {
  isOpen: boolean;
  fullWidth?: boolean;
  searchQuery: string;
  searchStatus: FindStatus;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (value: string) => void;
  onStep: (direction: 'next' | 'prev') => void;
  onClose: () => void;
}

export function FindBar({
  isOpen,
  fullWidth = false,
  searchQuery,
  searchStatus,
  searchInputRef,
  onQueryChange,
  onStep,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  if (!isOpen) return null;

  return (
    <div
      className={cn(
        // @@@floating-recipe (Refs #6106) — 原来是 `border + bg-background/95 + backdrop-blur`。
        // design.md 拒绝玻璃(「Decorative gradients, glows, blobs, textures, glass」),且浮层公式
        // 只有「实色底 + 圆角档 + 一层 lift」三件 —— 不叠描边。
        'absolute top-3 z-20 flex items-center gap-1 rounded-surface bg-background-quaternary p-1.5 shadow-lift',
        fullWidth ? 'left-3 right-3 w-auto max-w-none' : 'right-3 w-[min(28rem,calc(100%-1.5rem))]'
      )}
    >
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground-muted" />
        <Input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onStep(event.shiftKey ? 'prev' : 'next');
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          placeholder={translate('find.placeholder')}
          className="h-8 min-w-0 border-0 bg-transparent pr-2 pl-8 text-xs shadow-none focus-visible:ring-0"
          aria-label={translate('find.placeholder')}
        />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <span // 匹配计数是「数出来的数」,与标识符同族走 mono(design.md：mono 的唯一职责里含 a count)。
          className="min-w-10 shrink-0 px-1 text-center font-mono text-tiny tracking-tight text-foreground-muted">
          {searchQuery ? `${searchStatus.currentIndex}/${searchStatus.total}` : '0/0'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onStep('prev')}
          disabled={!searchQuery || searchStatus.total === 0}
          className="shrink-0 text-foreground-muted"
          aria-label={translate('find.previous')}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onStep('next')}
          disabled={!searchQuery || searchStatus.total === 0}
          className="shrink-0 text-foreground-muted"
          aria-label={translate('find.next')}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          className="shrink-0 text-foreground-muted"
          aria-label={translate('find.close')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
