import { useMemo, useState } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Textarea } from '@renderer/lib/ui/textarea';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { PromptLibraryPrompt } from '@shared/prompt-library';

export type PromptFormResult = Pick<PromptLibraryPrompt, 'title' | 'prompt'>;

type PromptModalArgs = {
  initialPrompt?: PromptLibraryPrompt | PromptFormResult;
};

type Props = BaseModalProps<PromptFormResult> & PromptModalArgs;

export function PromptModal({ initialPrompt, onSuccess, onClose }: Props) {
  const initialForm = useMemo<PromptFormResult>(
    () => ({
      title: initialPrompt?.title ?? '',
      prompt: initialPrompt?.prompt ?? '',
    }),
    [initialPrompt]
  );
  const [form, setForm] = useState(initialForm);
  const { translate } = useSessionMessages();

  const normalizedTitle = form.title.trim();
  const normalizedPrompt = form.prompt.trim();
  const canSave = normalizedTitle.length > 0 && normalizedPrompt.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSuccess({ title: normalizedTitle, prompt: normalizedPrompt });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {initialPrompt ? translate('prompts.edit') : translate('prompts.new')}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-4 pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>{translate('prompts.titleLabel')}</FieldLabel>
            <Input
              data-autofocus
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={translate('prompts.titlePlaceholder')}
            />
          </Field>
          <Field>
            <FieldLabel>{translate('prompts.promptLabel')}</FieldLabel>
            <Textarea
              value={form.prompt}
              onChange={(e) => setForm((prev) => ({ ...prev, prompt: e.target.value }))}
              placeholder={translate('prompts.bodyPlaceholder')}
              className="max-h-[50dvh] min-h-56 resize-y overflow-y-auto px-3 py-2.5 text-[length:var(--font-body)] leading-relaxed"
            />
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <ConfirmButton onClick={handleSave} disabled={!canSave}>
          {translate('prompts.save')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
