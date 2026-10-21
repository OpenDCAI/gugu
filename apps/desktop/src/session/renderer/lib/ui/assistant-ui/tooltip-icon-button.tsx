/**
 * Vendored from assistant-ui Elements — `https://r.assistant-ui.com/tooltip-icon-button.json`.
 * 改动见本目录 README。要点：上游用 `radix-ui` 的 `Slot.Slottable` 包 children，
 * 那只在 `asChild` 组合下有意义，这里不用 asChild，所以直接渲染 children —— 本目录因此
 * 当前 0 个 radix import。
 */
import * as React from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';

export type TooltipIconButtonProps = React.ComponentPropsWithoutRef<typeof Button> & {
  /** 同时是可见 tooltip 文案与 sr-only 名字 —— 图标按钮不能只有图标。 */
  tooltip: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
};

export const TooltipIconButton = React.forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  function TooltipIconButton({ children, tooltip, side = 'bottom', className, ...rest }, ref) {
    return (
      <TooltipProvider delay={0}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={ref}
                variant="ghost"
                size="icon"
                {...rest}
                className={cn('aui-button-icon active:scale-90', className)}
              >
                {children}
                <span className="sr-only">{tooltip}</span>
              </Button>
            }
          />
          <TooltipContent side={side}>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
);
