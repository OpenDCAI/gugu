import { useQuery } from '@tanstack/react-query';
import { Clock } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { Separator } from '@renderer/lib/ui/separator';
import { cn } from '@renderer/utils/utils';
import type { SessionPageStore } from '../stores/session-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type AutomationRunPillProps = {
  runId: string;
  projectId: string;
  sessionPageStore: SessionPageStore;
  isConverted: boolean;
};

export const AutomationRunPill = observer(function AutomationRunPill({
  runId,
  projectId,
  sessionPageStore,
  isConverted,
}: AutomationRunPillProps) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  const [isConverting, setIsConverting] = useState(false);

  const runQuery = useQuery({
    queryKey: ['automations', 'run', runId],
    queryFn: () => rpc.automations.getRun(runId),
    enabled: !!runId,
  });

  const automationsQuery = useQuery({
    queryKey: ['automations', projectId],
    queryFn: () => rpc.automations.listAutomations(projectId),
    enabled: !!projectId && open,
  });

  const run = runQuery.data ?? null;
  const automation = run
    ? automationsQuery.data?.find((a) => a.id === run.automationId)
    : undefined;

  const timestamp = run?.finishedAt ?? run?.startedAt ?? run?.scheduledAt ?? null;
  const automationName = automation?.name ?? run?.automationId ?? '…';

  async function handleConvert() {
    setIsConverting(true);
    try {
      await sessionPageStore.convertAutomationSession();
      setOpen(false);
    } finally {
      setIsConverting(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'ml-1 flex items-center gap-1.5 rounded-lg px-2 py-1 bg-background-1',
          // ❌ 曾经这里有 hover:border-border-1:只写了颜色没写宽度,是一条永不渲染的死类
          // (line budget —— 2026-09-22 删掉,悬浮反馈已经靠下面的文字变色表达)。
          'text-xs text-foreground-muted hover:text-foreground',
          'transition-colors'
        )}
      >
        <Clock className="size-3" />
        <span className="max-w-28 truncate">{automationName}</span>
        {timestamp != null && (
          <RelativeTime value={timestamp} compact className="text-foreground-passive" />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <MicroLabel className="text-foreground-passive">
            {translate('automation.automation')}
          </MicroLabel>
          <span className="text-sm tracking-tight">{automationName}</span>
        </div>
        {timestamp != null && (
          <div className="flex flex-col gap-1">
            <MicroLabel className="text-foreground-passive">{translate('automation.runDate')}</MicroLabel>
            <span className="text-sm">
              {new Date(timestamp).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </div>
        )}
        {!isConverted && (
          <>
            <Separator />
            <div className="flex flex-col gap-1">
              <p className="text-xs text-foreground-muted">
                {translate('automation.convertHint')}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isConverting}
                onClick={() => void handleConvert()}
              >
                {translate(isConverting ? 'automation.converting' : 'automation.convert')}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
});
