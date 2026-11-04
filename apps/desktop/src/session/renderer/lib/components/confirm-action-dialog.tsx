import { useState, type ReactNode } from 'react';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export type ConfirmActionDialogArgs = {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  variant?: 'destructive' | 'default';
  /**
   * 传了才长出「不再询问」复选框,勾选状态随确认一起回给调用方(取消不回传:没确认的动作不该
   * 顺手改掉一条偏好)。只用于已有明确默认动作、任务内容可恢复的流程;归档免确认授权默认移出身份,
   * 恢复任务时换新身份。真正丢弃不可恢复内容的动作不提供这项偏好。
   */
  dontAskAgainLabel?: string;
  /**
   * 传了才长出**范围**勾选(spec session-graph 的「连同 N 条子会话一起归档」)。它改变这次动作**做什么**,
   * 所以住在正文里、默认不勾;页脚那个「不再询问」改的是偏好,两者不是一类东西。
   * ❌ 在勾了也不改变结果的时候摆它(名下没有子会话时就不要传)——一个假开关比没有更坏。
   */
  scopeLabel?: string;
  /** An explicit choice for this action, independent of its descendant scope. */
  option?: { label: string; defaultChecked: boolean; disabled?: boolean };
  /** 传了,「取消」键就是一句「不」,与关掉弹窗(Esc / 点外面)分开报;不传两者同为 onClose。 */
  onCancel?: () => void;
  /** 「取消」键另有说法时(它是另一个动作,如「只关会话」)。不传 = 「取消」。 */
  cancelLabel?: string;
};

/**
 * 确认的结果。`dontAskAgain` 只在调用方给了 `dontAskAgainLabel` 时可能为 true;
 * `scopeChecked` 同理只在给了 `scopeLabel` 时可能为 true。
 */
export type ConfirmActionResult = { dontAskAgain: boolean; scopeChecked: boolean; optionChecked: boolean };

type Props = BaseModalProps<ConfirmActionResult> & ConfirmActionDialogArgs;

export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  variant = 'destructive',
  dontAskAgainLabel,
  scopeLabel,
  option,
  onCancel,
  cancelLabel,
  onSuccess,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [scopeChecked, setScopeChecked] = useState(false);
  const [optionChecked, setOptionChecked] = useState(option?.defaultChecked ?? false);
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        {/* 换行是内容的一部分(扩展授权框一行一项权限),❌ 让 HTML 把它们挤成一行。 */}
        {typeof description === 'string' ? <p className="whitespace-pre-line">{description}</p> : description}
        {option ? (
          <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
            <Checkbox disabled={option.disabled} checked={optionChecked} onCheckedChange={(checked) => setOptionChecked(Boolean(checked))} />
            <span className="min-w-0">{option.label}</span>
          </label>
        ) : null}
        {scopeLabel ? (
          // 正文里、紧跟着那句话:它说的是这次动作会带走什么,不是一条偏好。
          <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              checked={scopeChecked}
              onCheckedChange={(checked) => setScopeChecked(Boolean(checked))}
            />
            <span className="min-w-0">{scopeLabel}</span>
          </label>
        ) : null}
      </DialogContentArea>
      <DialogFooter className={dontAskAgainLabel ? 'sm:flex-wrap' : undefined}>
        {dontAskAgainLabel ? (
          // 页脚里**自占一行**(basis-full),按钮组折到下一行靠右:它是这次确认的一部分,不是正文里的
          // 又一句说明,但❌ 与按钮抢同一行。xs 确认框只有 320px,复选框 + 取消 + 带键帽的确认钮放不下;
          // 页脚 justify-end,一行溢出时多出的那段挤向**左边**,再被弹窗的 overflow-hidden 裁掉 —— 裁掉的
          // 正是复选框,剩下的字照样能点,于是用户勾上一个看不见的「不再询问」(#6544)。
          <label className="flex basis-full items-center gap-2 text-sm text-foreground-muted">
            <Checkbox
              checked={dontAskAgain}
              onCheckedChange={(checked) => setDontAskAgain(Boolean(checked))}
            />
            <span className="min-w-0">{dontAskAgainLabel}</span>
          </label>
        ) : null}
        <Button variant="outline" onClick={onCancel ?? onClose}>
          {cancelLabel ?? translate('common.cancel')}
        </Button>
        <ConfirmButton variant={variant} onClick={() => onSuccess({ dontAskAgain, scopeChecked, optionChecked })}>
          {confirmLabel ?? translate('common.confirm')}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
