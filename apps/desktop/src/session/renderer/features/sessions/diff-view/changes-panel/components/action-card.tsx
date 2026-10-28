import { type ReactNode } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface ActionCardProps {
  selectedCount: number;
  selectionActions: ReactNode;
  generalActions: ReactNode;
}

export function ActionCard({ selectedCount, selectionActions, generalActions }: ActionCardProps) {
  const { translate } = useSessionMessages();
  const hasSelection = selectedCount > 0;
  return (
    // 密度面板,不画框(design.md:prefer a change of density over a box —— 2026-09-22 去掉 border,
    // 它与 commit-card.tsx 曾是同一份 `border + bg-background-1` 模板抄两遍)。
    <div className="mx-2 flex shrink-0 items-center justify-between rounded-lg bg-background-1 py-1.5 pr-1.5 pl-2.5">
      <span className="min-w-0 truncate text-xs text-foreground-muted">
        {hasSelection
          ? translate('changes.selectedFiles', { count: selectedCount })
          : translate('changes.allFiles')}
      </span>
      <div className="flex items-center gap-1.5">
        {hasSelection ? selectionActions : generalActions}
      </div>
    </div>
  );
}
