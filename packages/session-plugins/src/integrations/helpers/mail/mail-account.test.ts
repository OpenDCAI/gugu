import { describe, expect, it } from 'vitest';
import { mailAccountFromForm } from './mail-account';
import { verifyMailCredentials } from './mail-verify';

/** 表单填的地址 → 该连哪台服务器(#7240)。连不连得上要真服务器,在 PR 里用本地 GreenMail 走过一遍。 */
describe('mailAccountFromForm', () => {
  it('QQ 邮箱:qq.com / foxmail.com 都连 imap.qq.com:993、smtp.qq.com:465;授权码里的空格去掉(网页上是四个一组显示的)', () => {
    expect(mailAccountFromForm('qq', { email: ' me@foxmail.com ', password: 'abcd efgh ijkl mnop' })).toEqual({
      email: 'me@foxmail.com',
      password: 'abcdefghijklmnop',
      imap: { host: 'imap.qq.com', port: 993, secure: true },
      smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    });
  });

  it('网易邮箱:按域名选 163 / 126 / yeah.net 那一台', () => {
    expect(mailAccountFromForm('netease', { email: 'a@126.com', password: 'x' }).imap.host).toBe('imap.126.com');
    expect(mailAccountFromForm('netease', { email: 'a@163.com', password: 'x' }).smtp.host).toBe('smtp.163.com');
    expect(mailAccountFromForm('netease', { email: 'a@yeah.net', password: 'x' }).imap.host).toBe('imap.yeah.net');
  });

  it('地址和服务商对不上 → 说清楚该用哪一家,❌ 猜一台服务器去试', () => {
    expect(() => mailAccountFromForm('qq', { email: 'a@163.com', password: 'x' })).toThrow(/not a QQ Mail address/);
    expect(() => mailAccountFromForm('netease', { email: 'a@qq.com', password: 'x' })).toThrow(/not a NetEase Mail address/);
    expect(() => mailAccountFromForm('qq', { email: 'not-an-address', password: 'x' })).toThrow(/not an email address/);
    expect(() => mailAccountFromForm('qq', { email: 'a@qq.com', password: '  ' })).toThrow(/authorization code is empty/);
  });

  it('企业邮箱:服务器由人填,`host:port`;993 / 465 直接 SSL,别的端口先明文再升级', () => {
    expect(
      mailAccountFromForm('enterprise', { email: 'a@corp.com', password: 'x', imapHost: 'imap.qiye.163.com', smtpHost: 'smtp.corp.com:587' })
    ).toMatchObject({
      imap: { host: 'imap.qiye.163.com', port: 993, secure: true },
      smtp: { host: 'smtp.corp.com', port: 587, secure: false },
    });
    expect(() => mailAccountFromForm('enterprise', { email: 'a@corp.com', password: 'x', imapHost: '' })).toThrow(/IMAP and the SMTP/);
  });
});

describe('verifyMailCredentials —— 填错的在连服务器之前就拦下', () => {
  it('地址不对 → invalid_input(界面说「凭据验证失败」,悬停是原话)', async () => {
    await expect(verifyMailCredentials('qq', { email: 'a@163.com', password: 'x' })).resolves.toEqual({
      connected: false,
      error: { type: 'invalid_input', message: expect.stringContaining('not a QQ Mail address') },
    });
  });
});
