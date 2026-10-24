import { Check, Copy, ExternalLink, Globe } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export type ExternalLinkChoice = 'emdash-browser' | 'external-browser';

export type ExternalLinkChoiceDialogArgs = {
  url: string;
  canOpenInEmdashBrowser: boolean;
  onCopy: () => boolean | Promise<boolean>;
};

type Props = BaseModalProps<ExternalLinkChoice> & ExternalLinkChoiceDialogArgs;

export function ExternalLinkChoiceDialog({
  url,
  canOpenInEmdashBrowser,
  onCopy,
  onSuccess,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    []
  );

  const handleCopy = async () => {
    if (!(await onCopy())) return;
    setCopied(true);
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => {
      setCopied(false);
      copyResetRef.current = null;
    }, 1_500);
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{translate('externalLink.title')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-4 pt-0 text-sm leading-relaxed">
        <div className="bg-background-2/50 relative rounded-md border border-border">
          <div className="max-h-32 overflow-y-auto px-3 py-2.5 pr-10 font-mono text-xs leading-relaxed break-all text-foreground">
            {url}
          </div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1.5 right-1.5"
                    aria-label={translate(
                      copied ? 'externalLink.linkCopied' : 'externalLink.copyLink'
                    )}
                    onClick={() => void handleCopy()}
                  />
                }
              >
                {copied ? (
                  <Check className="size-4 text-foreground-success" />
                ) : (
                  <Copy className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipContent>
                {translate(copied ? 'externalLink.copied' : 'externalLink.copyLink')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </DialogContentArea>
      <DialogFooter className="flex-col-reverse sm:flex-col-reverse">
        <Button className="w-full" variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          disabled={!canOpenInEmdashBrowser}
          onClick={() => onSuccess('emdash-browser')}
        >
          <Globe className="size-4" />
          {translate('preview.openInGuguBrowser')}
        </Button>
        <Button className="w-full" variant="default" onClick={() => onSuccess('external-browser')}>
          <ExternalLink className="size-4" />
          {translate('preview.openInSystemBrowser')}
        </Button>
      </DialogFooter>
    </>
  );
}
