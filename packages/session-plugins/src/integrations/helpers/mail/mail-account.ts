import z from 'zod';

/**
 * 邮箱集成(#7240):QQ 邮箱、网易邮箱、企业邮箱都走 IMAP 收、SMTP 发,用邮箱给的「授权码」登录
 * (不是网页登录密码;QQ / 网易在网页版设置里开 IMAP/SMTP 后生成)。
 *
 * 这里只管「这个地址该连哪台服务器」与存下来的那一份长什么样,收发在 mail-client.ts。
 */

export type MailProvider = 'qq' | 'netease' | 'enterprise';

export type MailServer = { host: string; port: number; secure: boolean };

/** 存进凭据库的一份:地址、授权码、两台服务器。一个邮箱一份(多个邮箱 = 多个账号)。 */
export const mailAccountSchema = z.object({
  email: z.string(),
  password: z.string(),
  imap: z.object({ host: z.string(), port: z.number(), secure: z.boolean() }),
  smtp: z.object({ host: z.string(), port: z.number(), secure: z.boolean() }),
});

export type MailAccount = z.infer<typeof mailAccountSchema>;

const IMAPS = 993;
const SMTPS = 465;

const NETEASE_DOMAINS: Record<string, string> = {
  '163.com': '163.com',
  '126.com': '126.com',
  'yeah.net': 'yeah.net',
  'vip.163.com': 'vip.163.com',
  'vip.126.com': 'vip.126.com',
};

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : '';
}

/** `host` 或 `host:port`;不写端口 = 默认的 SSL 端口。 */
function parseServer(value: string, defaultPort: number): MailServer {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^:\s]+)(?::(\d+))?$/);
  if (!match?.[1]) throw new Error(`"${value}" is not a mail server address.`);
  const port = match[2] ? Number(match[2]) : defaultPort;
  // 465 / 993 是直接 SSL;别的端口(587 / 143)先明文再升级 —— nodemailer / imapflow 都按 secure:false 处理。
  return { host: match[1].toLowerCase(), port, secure: port === IMAPS || port === SMTPS };
}

export type MailFormInput = {
  email?: string;
  password?: string;
  imapHost?: string;
  smtpHost?: string;
};

/**
 * 表单填的 → 存的那一份。地址不对、服务商对不上就抛(说清楚该怎么填),❌ 猜一台服务器去试。
 */
export function mailAccountFromForm(provider: MailProvider, input: MailFormInput): MailAccount {
  const email = (input.email ?? '').trim();
  const password = (input.password ?? '').replace(/\s+/g, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);
  if (!password) throw new Error('The authorization code is empty.');
  const domain = domainOf(email);

  if (provider === 'qq') {
    if (domain !== 'qq.com' && domain !== 'foxmail.com' && domain !== 'vip.qq.com') {
      throw new Error(`${email} is not a QQ Mail address (@qq.com / @foxmail.com). Use 企业邮箱 for other domains.`);
    }
    return {
      email,
      password,
      imap: { host: 'imap.qq.com', port: IMAPS, secure: true },
      smtp: { host: 'smtp.qq.com', port: SMTPS, secure: true },
    };
  }

  if (provider === 'netease') {
    const base = NETEASE_DOMAINS[domain];
    if (!base) {
      throw new Error(`${email} is not a NetEase Mail address (@163.com / @126.com / @yeah.net). Use 企业邮箱 for other domains.`);
    }
    return {
      email,
      password,
      imap: { host: `imap.${base}`, port: IMAPS, secure: true },
      smtp: { host: `smtp.${base}`, port: SMTPS, secure: true },
    };
  }

  const imapHost = (input.imapHost ?? '').trim();
  const smtpHost = (input.smtpHost ?? '').trim();
  if (!imapHost || !smtpHost) throw new Error('Fill in both the IMAP and the SMTP server.');
  return { email, password, imap: parseServer(imapHost, IMAPS), smtp: parseServer(smtpHost, SMTPS) };
}
