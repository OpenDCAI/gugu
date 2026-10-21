import { RotateCcw } from '@/lib/icons'
import React from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface ResetToDefaultButtonProps {
  /** Optional label shown in the tooltip: "Reset to default: <label>" */
  defaultLabel?: string;
  onReset: () => void;
  disabled?: boolean;
  visible?: boolean;
}

export const ResetToDefaultButton: React.FC<ResetToDefaultButtonProps> = ({
  defaultLabel,
  onReset,
  disabled,
  visible = true,
}) => {
  const { translate } = useSessionMessages();

  if (!visible) {
    return <span aria-hidden="true" className="h-7 w-7 shrink-0" />;
  }

  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex h-7 w-7 shrink-0" />}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-foreground-muted h-7 w-7 shrink-0 hover:text-foreground"
            onClick={onReset}
            disabled={disabled}
            aria-label={translate('reset.toDefault')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {defaultLabel !== undefined
            ? translate('reset.toDefaultWith', { label: defaultLabel })
            : translate('reset.toDefault')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
