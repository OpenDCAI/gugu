// #6264「下次免密」:人答 SSH 密码时勾了「以后连这台机器不用再输密码」,咕咕在连上之后替他装好钥匙;
// 做完的结果(装好了 / 没做成、为什么)在这里弹一条提示。提问卡片那时已经收起(连上了),
// 终端 / 浏览器里 ❌ 插字 —— 这不是会话本身的事,是一次设置的回执。
import { useEffect, useRef } from 'react';
import { events } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sshKeyInstallChannel, type SshKeyInstallReport } from '@shared/ssh-key-install';
import type { Translate } from './connection-status';

/** 一次结果 → 一条提示的标题与说明(纯函数,单测直接测)。 */
export function sshKeyInstallToast(
  report: SshKeyInstallReport,
  translate: Translate
): { title: string; description?: string; variant?: 'destructive' } {
  if (report.outcome.status === 'installed') {
    return { title: translate('remoteHost.keyInstall.installed', { device: report.label }) };
  }
  return {
    title: translate('remoteHost.keyInstall.failed', { device: report.label }),
    description: translate(`remoteHost.keyInstall.reason.${report.outcome.reason}`),
    variant: 'destructive',
  };
}

export function SshKeyInstallToasts() {
  const { translate } = useSessionMessages();
  const translateRef = useRef(translate);
  translateRef.current = translate;
  useEffect(
    () => events.on(sshKeyInstallChannel, (report) => toast(sshKeyInstallToast(report, translateRef.current))),
    []
  );
  return null;
}
