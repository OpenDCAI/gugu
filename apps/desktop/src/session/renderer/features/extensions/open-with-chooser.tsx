import { useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** What the person picked: an App's tab, or the built-in editor (`null`); and whether to always. */
export type OpenWithChoice = { tabKind: string | null; always: boolean };

export type OpenWithChooserArgs = {
  fileName: string;
  candidates: { tabKind: string; tabTitle: string; appName: string; onlyTab: boolean }[];
};

type Props = BaseModalProps<OpenWithChoice> & OpenWithChooserArgs;

/**
 * 「用哪个打开」(真源 §2.4, 主人 09-29): several Apps claim this kind of file in a task, so the
 * person picks — as an operating system asks. The built-in editor is always one of the answers:
 * no install can make a file unopenable. 「始终用它」 remembers the pick for this suffix.
 */
export function OpenWithChooser({ fileName, candidates, onSuccess, onClose }: Props) {
  const { translate } = useSessionMessages();
  const [always, setAlways] = useState(false);
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{translate('extensions.openWithTitle', { name: fileName })}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-2 pt-0 text-sm">
        {candidates.map((candidate) => (
          <Button
            key={candidate.tabKind}
            className="w-full"
            variant="outline"
            data-open-with={candidate.tabKind}
            onClick={() => onSuccess({ tabKind: candidate.tabKind, always })}
          >
            <span className="flex flex-col items-start">
              <span>{candidate.appName}</span>
              {candidate.onlyTab ? null : <span className="text-xs text-muted-foreground">{candidate.tabTitle}</span>}
            </span>
          </Button>
        ))}
        <Button className="w-full" variant="outline" data-open-with="builtin" onClick={() => onSuccess({ tabKind: null, always })}>
          {translate('extensions.openInBuiltInEditor')}
        </Button>
        <label className="flex items-center gap-2 pt-1 text-muted-foreground">
          <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} data-testid="open-with-always" />
          {translate('extensions.openWithAlways')}
        </label>
      </DialogContentArea>
      <DialogFooter>
        <Button className="w-full" variant="ghost" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
      </DialogFooter>
    </>
  );
}
