import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { MailAccount } from './mail-account';

/**
 * 一个邮箱账号的收发:IMAP 查信、读信,SMTP 发信。每次调用连一次、用完就登出 —— 不常驻连接:
 * 邮箱服务商会踢掉长时间空闲的连接,而 agent 用信箱是零星的几次调用。
 *
 * 网易邮箱要求客户端先报上名字(IMAP ID 命令),否则拒绝:「Unsafe Login」。`clientInfo` 就是那一句。
 */

const CLIENT_INFO = { name: 'gugu', version: '1.0', vendor: 'gugu' };
const CONNECT_TIMEOUT_MS = 20_000;
/** 一封信的正文最多给 agent 这么多字;更长的截断并说明,❌ 一整封几兆的 HTML 塞进上下文。 */
const BODY_LIMIT = 20_000;

/** 本机回环上的服务器(测试用的本地邮件服务)没有人能在中间偷听;别的一律要加密。 */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function imapClient(account: MailAccount): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    // 非 SSL 端口(143):必须先升级成加密再登录,❌ 对方不支持加密就明文递授权码。
    ...(!account.imap.secure && !isLoopback(account.imap.host) ? { doSTARTTLS: true } : {}),
    auth: { user: account.email, pass: account.password },
    clientInfo: CLIENT_INFO,
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
}

/** 登录失败时服务器原话往往是英文缩写(「LOGIN failed」),补一句人该怎么办。 */
function explainImapError(account: MailAccount, error: unknown): Error {
  const failure = error as { authenticationFailed?: boolean; responseText?: string; message?: string };
  if (failure?.authenticationFailed) {
    return new Error(
      `${account.imap.host} refused ${account.email}: check the authorization code (not the web login password) and that IMAP is enabled in the mailbox settings.${failure.responseText ? ` Server said: ${failure.responseText}` : ''}`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function withImap<T>(account: MailAccount, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient(account);
  // 连接断开时 imapflow 会发 error 事件;没人听就成了进程级的未捕获异常。这里只记下,调用本身会报错。
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    throw explainImapError(account, error);
  }
  try {
    return await run(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function smtpTransport(account: MailAccount) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    // 587 / 25:同上,必须 STARTTLS 成功才登录。
    requireTLS: !account.smtp.secure && !isLoopback(account.smtp.host),
    auth: { user: account.email, pass: account.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });
}

/** 连接前核一遍:IMAP 能登录、SMTP 能登录。两头都过才算连上。 */
export async function verifyMailAccount(account: MailAccount): Promise<void> {
  await withImap(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
  });
  const transport = smtpTransport(account);
  try {
    await transport.verify();
  } catch (error) {
    throw new Error(
      `${account.smtp.host} refused to send as ${account.email}: ${(error as Error).message}. Check that SMTP is enabled in the mailbox settings.`
    );
  } finally {
    transport.close();
  }
}

export type MailFolder = { path: string; name: string; specialUse?: string };

export async function listMailFolders(account: MailAccount): Promise<MailFolder[]> {
  return withImap(account, async (client) =>
    (await client.list()).map((box) => ({
      path: box.path,
      name: box.name,
      ...(box.specialUse ? { specialUse: box.specialUse } : {}),
    }))
  );
}

function formatAddresses(list: MessageAddressObject[] | undefined): string {
  return (list ?? [])
    .map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ''}>` : entry.address ?? ''))
    .filter(Boolean)
    .join(', ');
}

export type MailSummary = {
  uid: number;
  folder: string;
  date?: string;
  from: string;
  to: string;
  subject: string;
  unread: boolean;
};

export type MailSearch = {
  folder?: string;
  /** 主题 / 发件人 / 收件人 / 正文里任意一处含有。 */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** YYYY-MM-DD,含当天。 */
  since?: string;
  /** YYYY-MM-DD,不含当天。 */
  before?: string;
  unreadOnly?: boolean;
  limit?: number;
};

/**
 * imapflow 按 UTC 的年月日写 SINCE / BEFORE(`toISOString().substring(0, 10)`):本地零点在东八区是前一天,
 * 查「10-15 以来」会多出 10-14 一整天。这里给 UTC 零点,写出去的就是人说的那一天。
 */
export function parseDay(value: string, label: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a date like 2026-10-15, got "${value}".`);
  return date;
}

function summaryOf(message: FetchMessageObject, folder: string): MailSummary {
  const date = message.envelope?.date ?? message.internalDate;
  return {
    uid: message.uid,
    folder,
    ...(date ? { date: new Date(date).toISOString() } : {}),
    from: formatAddresses(message.envelope?.from),
    to: formatAddresses(message.envelope?.to),
    subject: message.envelope?.subject ?? '',
    unread: !message.flags?.has('\\Seen'),
  };
}

/** 按条件查,新的在前,最多 `limit` 封(默认 20,上限 100)。 */
export async function searchMail(account: MailAccount, search: MailSearch): Promise<MailSummary[]> {
  const folder = search.folder?.trim() || 'INBOX';
  const limit = Math.min(Math.max(search.limit ?? 20, 1), 100);
  const query: SearchObject = {};
  if (search.from) query.from = search.from;
  if (search.to) query.to = search.to;
  if (search.subject) query.subject = search.subject;
  if (search.since) query.since = parseDay(search.since, 'since');
  if (search.before) query.before = parseDay(search.before, 'before');
  if (search.unreadOnly) query.seen = false;
  if (search.text) query.or = [{ subject: search.text }, { from: search.text }, { to: search.text }, { body: search.text }];
  if (Object.keys(query).length === 0) query.all = true;

  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) return [];
      const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
      const found: MailSummary[] = [];
      for await (const message of client.fetch(newest, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
        found.push(summaryOf(message, folder));
      }
      return found.sort((a, b) => b.uid - a.uid);
    } finally {
      lock.release();
    }
  });
}

export type MailMessage = MailSummary & {
  cc: string;
  messageId?: string;
  text: string;
  truncated: boolean;
  attachments: { filename?: string; contentType: string; size: number }[];
};

/** 读一封:正文(纯文本;只有 HTML 的转成文本),附件只列名字与大小。读了会标为已读(与在邮箱里打开一样)。 */
export async function readMail(account: MailAccount, { folder, uid }: { folder?: string; uid: number }): Promise<MailMessage> {
  const box = folder?.trim() || 'INBOX';
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(box);
    try {
      const message = await client.fetchOne(uid, { envelope: true, flags: true, internalDate: true, source: true }, { uid: true });
      if (!message || !message.source) throw new Error(`No message with uid ${uid} in ${box}.`);
      const parsed = await simpleParser(message.source);
      const body = (parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '')).trim();
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      return {
        ...summaryOf(message, box),
        unread: false,
        cc: formatAddresses(message.envelope?.cc),
        ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
        text: body.length > BODY_LIMIT ? body.slice(0, BODY_LIMIT) : body,
        truncated: body.length > BODY_LIMIT,
        attachments: parsed.attachments.map((attachment) => ({
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          contentType: attachment.contentType,
          size: attachment.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

export type MailDraft = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** 回复某封时带上它的 Message-ID,对方客户端会归到同一串里。 */
  inReplyTo?: string;
};

export async function sendMail(
  account: MailAccount,
  draft: MailDraft
): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  if (draft.to.length === 0) throw new Error('A message needs at least one recipient.');
  const transport = smtpTransport(account);
  try {
    const info = await transport.sendMail({
      from: account.email,
      to: draft.to,
      ...(draft.cc?.length ? { cc: draft.cc } : {}),
      ...(draft.bcc?.length ? { bcc: draft.bcc } : {}),
      subject: draft.subject,
      text: draft.text,
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo, references: draft.inReplyTo } : {}),
    });
    const address = (entry: unknown) => (typeof entry === 'string' ? entry : (entry as { address?: string }).address ?? '');
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(address),
      rejected: (info.rejected ?? []).map(address),
    };
  } finally {
    transport.close();
  }
}
