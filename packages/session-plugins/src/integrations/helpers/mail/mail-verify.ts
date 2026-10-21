import type { VerifyResult } from '../../capabilities/auth';
import type { IntegrationCredentials } from '../../host';
import { mailAccountFromForm, mailAccountSchema, type MailAccount, type MailFormInput, type MailProvider } from './mail-account';
import { verifyMailAccount } from './mail-client';

/** 连不上服务器(地址写错、网络不通)与登录被拒是两件事,界面上说法不同。 */
function isUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(code);
}

/**
 * 邮箱集成的 `verify`:表单填的(连接时)或存着的那一份(查状态时)都认。
 * IMAP 能登录、SMTP 能登录才算连上;一个邮箱地址一个账号,同一家可以连多个。
 */
export async function verifyMailCredentials(provider: MailProvider, credentials: IntegrationCredentials): Promise<VerifyResult> {
  let account: MailAccount;
  const stored = mailAccountSchema.safeParse(credentials);
  try {
    account = stored.success ? stored.data : mailAccountFromForm(provider, credentials as MailFormInput);
  } catch (error) {
    return { connected: false, error: { type: 'invalid_input', message: (error as Error).message } };
  }
  try {
    await verifyMailAccount(account);
  } catch (error) {
    const message = (error as Error).message;
    return {
      connected: false,
      error: isUnreachable(error) ? { type: 'host_unreachable', message } : { type: 'auth_failed', message },
    };
  }
  return {
    connected: true,
    account: { id: account.email.toLowerCase(), login: account.email, host: account.imap.host },
    displayName: account.email,
    displayDetail: account.imap.host,
    // 表单那几项也按原名存一份(`imapHost` / `smtpHost`):「编辑凭据」时预填,改回去也认得。
    credentials: {
      ...account,
      imapHost: `${account.imap.host}:${account.imap.port}`,
      smtpHost: `${account.smtp.host}:${account.smtp.port}`,
    },
  };
}
