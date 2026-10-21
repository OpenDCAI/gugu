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
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { findSessionShellPort } from '@renderer/lib/shell-port';
import { sessionAgentNames } from './stores/session-agent-names';

type RenameAgentModalArgs = {
  sessionId: string;
  currentName: string;
};

type Props = BaseModalProps<void> & RenameAgentModalArgs;

/**
 * 「重命名 Agent」(#6091):改这条会话背后那个咕咕 agent 在通讯录里的名字(`Codex 8`),别人 @ 它、群里叫它
 * 都用这个。与「重命名会话」是**两件事、两个入口、两个弹窗**(owner 2026-09-21:「他们是独立的」),
 * ❌ 塞进同一个表单。
 *
 * 走壳口 `renameAgent`:云端 display_name + 本机花名册一次改完,与聊天页资料卡改名同一条链路,
 * ❌ 不另开一条只改一半的近路。从前它藏在分享浮层的双击里,分享收回成纯分享后(#6093)入口就在这儿。
 * 只有已经有咕咕身份的会话才会出现这个入口(侧栏右键菜单按 session-agent-names 判)。
 */
export const RenameAgentModal = observer(function RenameAgentModal({
  sessionId,
  currentName,
  onSuccess,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  const [name, setName] = useState(currentName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = name.trim();
  const isValid = normalized.length > 0 && normalized !== currentName;

  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const shell = findSessionShellPort();
      if (!shell) throw new Error(translate('task.renameAgentFailed'));
      const renamed = await shell.renameAgent({ sessionId, name: normalized });
      // 主进程会播 sessionpage-agent-renamed 让表跟上;这里先写一笔是为了弹窗关掉的那一帧侧栏已经是新名。
      sessionAgentNames.note(renamed.conversationId, renamed.displayName, renamed.agentUserId);
      onSuccess();
    } catch (e) {
      // 底层错误原文是诊断数据,原样呈现;只有「连 message 都没有」时才落到本地化外壳。
      setError(e instanceof Error ? e.message : translate('task.renameAgentFailed'));
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{translate('task.renameAgentTitle')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <FieldGroup>
          <Field>
            <FieldLabel>{translate('task.renameAgentNameLabel')}</FieldLabel>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
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
