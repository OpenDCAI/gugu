// #6264「下次免密」的回执:装好了说一句;没做成说清下次还会问密码、为什么(文案按界面语言,中英都在)。
import { describe, expect, it } from 'vitest';
import { enUSRemoteHostMessages, zhCNRemoteHostMessages } from '@renderer/localization/messages-remote-hosts';
import { sshKeyInstallToast } from './ssh-key-install-toasts';

const translate = (key: string, values: Record<string, unknown> = {}) =>
  String(zhCNRemoteHostMessages[key as keyof typeof zhCNRemoteHostMessages] ?? `MISSING:${key}`).replace(/\{(\w+)\}/g, (_, k) =>
    String(values[k] ?? '')
  );

describe('sshKeyInstallToast', () => {
  it('装好了:一句话,带机器名', () => {
    expect(sshKeyInstallToast({ label: 'alice@box', outcome: { status: 'installed' } }, translate)).toEqual({
      title: '已为 alice@box 设好免密',
    });
  });

  it('没做成:醒目,标题说没设好,说明给原因;四种原因中英文都有', () => {
    const toast = sshKeyInstallToast({ label: 'alice@box', outcome: { status: 'failed', reason: 'not-accepted' } }, translate);
    expect(toast.variant).toBe('destructive');
    expect(toast.title).toContain('未能为 alice@box 设好免密');
    expect(toast.description).toContain('不接受免密登录');
    for (const reason of ['not-accepted', 'write-failed', 'no-key', 'unreachable']) {
      expect(enUSRemoteHostMessages).toHaveProperty(`remoteHost.keyInstall.reason.${reason}`);
      expect(zhCNRemoteHostMessages).toHaveProperty(`remoteHost.keyInstall.reason.${reason}`);
    }
  });
});
