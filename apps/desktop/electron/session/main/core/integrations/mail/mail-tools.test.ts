import { describe, expect, it } from 'vitest';
import { mailIntegrationTools } from './mail-tools';

const account = (email: string) => ({
  email,
  password: 'code',
  imap: { host: '127.0.0.1', port: 1, secure: false },
  smtp: { host: '127.0.0.1', port: 1, secure: false },
});

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

/** 会话里的邮箱工具:连了几个邮箱、用哪一个(#7240)。收发本身在 PR 里对本地 GreenMail 真跑过。 */
describe('mailIntegrationTools', () => {
  it('工具说明里写着连的是哪几个邮箱(每次现读)', async () => {
    let connected = [account('a@qq.com')];
    const tools = mailIntegrationTools('QQ 邮箱', async () => connected);
    expect((await tools.list(AbortSignal.timeout(1000)))[0]?.description).toContain('connected: a@qq.com');
    connected = [account('a@qq.com'), account('b@qq.com')];
    expect((await tools.list(AbortSignal.timeout(1000)))[0]?.description).toContain('connected: a@qq.com, b@qq.com');
  });

  it('连了两个、没说用哪个 → 报错并列出可选的(❌ 随便挑一个去发信)', async () => {
    const tools = mailIntegrationTools('QQ 邮箱', async () => [account('a@qq.com'), account('b@qq.com')]);
    const result = await tools.call('send_mail', { to: ['x@y.com'], subject: 's', text: 't' }, AbortSignal.timeout(1000));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('a@qq.com, b@qq.com');
  });

  it('点名一个没连的 → 报错;一个都没连 → 叫人去资源库连', async () => {
    const one = mailIntegrationTools('QQ 邮箱', async () => [account('a@qq.com')]);
    expect(textOf(await one.call('list_folders', { account: 'c@qq.com' }, AbortSignal.timeout(1000)))).toContain(
      'not a connected QQ 邮箱 mailbox'
    );
    const none = mailIntegrationTools('QQ 邮箱', async () => []);
    expect(textOf(await none.call('list_folders', {}, AbortSignal.timeout(1000)))).toContain('connect one in the library');
  });

  it('发信缺主题 / 正文 → 不连服务器就拦下;存坏的那一份不算连着', async () => {
    const tools = mailIntegrationTools('QQ 邮箱', async () => [account('a@qq.com'), { email: 'broken' }]);
    expect(textOf(await tools.call('send_mail', { to: ['x@y.com'], subject: '', text: 't' }, AbortSignal.timeout(1000)))).toBe(
      'subject is empty.'
    );
    expect((await tools.list(AbortSignal.timeout(1000)))[0]?.description).toContain('connected: a@qq.com)');
  });

  it('收件人里有不是地址的 → 整封不发、说出是哪一个(❌ 丢掉它照样发)', async () => {
    const tools = mailIntegrationTools('QQ 邮箱', async () => [account('a@qq.com')]);
    const result = await tools.call('send_mail', { to: ['ok@x.com', 5], subject: 's', text: 't' }, AbortSignal.timeout(1000));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/to has something that is not an email address: 5\. Nothing was sent\./);
    const notAList = await tools.call('send_mail', { to: ['ok@x.com'], bcc: { a: 1 }, subject: 's', text: 't' }, AbortSignal.timeout(1000));
    expect(textOf(notAList)).toBe('bcc must be a list of email addresses.');
  });
});
