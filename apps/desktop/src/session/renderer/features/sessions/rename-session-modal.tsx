import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
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
import { MAX_TASK_AGENT_NAME_GRAPHEMES, taskAgentNameLength } from '@gugu/core/shared/taskAgentName';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sessionRegistry } from './stores/session-registry';

type RenameSessionModalArgs = {
  sessionId: string;
  currentTitle: string;
  /**
   * #6264 别的机器上的会话:标题落在那台机器上,由调用方给出怎么改。缺省 = 本机会话,走 registry。
   * 对话框本身(校验、错误原文、按钮)两边同一个,❌ 给远端另画一个输入框。
   */
  rename?: (title: string) => Promise<unknown>;
  /**
   * #6264 同一个改名框给「别的机器改名」用时换掉标题与字段名(❌ 为机器另画一个输入框)。缺省 = 会话。
   */
  labels?: { title: string; field: string };
};

type Props = BaseModalProps<void> & RenameSessionModalArgs;

/** Local and remote task menus share this dialog and the canonical identity rename operation. */
export const RenameSessionModal = observer(function RenameSessionModal({
  sessionId,
  currentTitle,
  rename,
  labels,
  onSuccess,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  const [title, setTitle] = useState(currentTitle);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = title.trim();
  const withinLimit = labels ? normalized.length <= MAX_SESSION_TITLE_LENGTH : taskAgentNameLength(normalized) <= MAX_TASK_AGENT_NAME_GRAPHEMES;
  const isValid = normalized.length > 0 && withinLimit && normalized !== currentTitle;

  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      if (rename) await rename(normalized);
      else await sessionRegistry.get(sessionId)?.renameSession(sessionId, normalized);
      onSuccess();
    } catch (e) {
      // 底层错误原文是诊断数据,原样呈现;只有「连 message 都没有」时才落到本地化外壳。
      setError(e instanceof Error ? e.message : translate('task.renameFailed'));
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{labels?.title ?? translate('task.renameTitle')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>{labels?.field ?? translate('task.renameNameLabel')}</FieldLabel>
            <Input
              value={title}
              maxLength={labels ? MAX_SESSION_TITLE_LENGTH : undefined}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
              data-autofocus
              autoFocus
            />
            {error && <p className="text-foreground-destructive mt-1 text-xs">{error}</p>}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('common.cancel')}
        </Button>
        <ConfirmButton onClick={() => void handleSubmit()} disabled={!isValid || isSubmitting}>
          {isSubmitting ? translate('task.renaming') : translate('task.rename')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
});
