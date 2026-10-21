import type { ReactNode } from 'react';
import { DialogTitle } from '@renderer/lib/ui/dialog';

/**
 * 登录弹窗的标题 —— 多步时(#6335:一颗「登录」依次登完一家的几个程序)旁边带「第 1 步,共 2 步」,
 * 单步不多画。终端登录与协议登录两种正文共用这一份。
 */
export function SignInTitle({ title, stepLabel }: { title: ReactNode; stepLabel: string | null }) {
  return (
    <DialogTitle>
      {title}
      {stepLabel && <span className="ml-2 text-sm font-normal text-foreground-muted">{stepLabel}</span>}
    </DialogTitle>
  );
}
