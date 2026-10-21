import {
  listMailFolders,
  mailAccountSchema,
  readMail,
  searchMail,
  sendMail,
  type MailAccount,
} from '@gugu/session-plugins/integrations';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { LocalIntegrationTools } from '../../../../../integration-mcp-bridge';

/**
 * #7240 邮箱在会话里的工具:查信、读信、发信、列文件夹。收发在**连着这个邮箱的那台机器**上做
 * (IMAP / SMTP 直连服务商),凭据每次现读 —— 会话开着时又连了一个邮箱、或断开了,下一次调用就按新的来。
 *
 * 一家连了几个邮箱时,工具带 `account` 参数指明用哪一个;只连了一个就不必写。
 */

const MAIL_INTEGRATIONS = new Set(['qq-mail', 'netease-mail', 'enterprise-mail']);

export function isMailIntegration(integrationId: string): boolean {
  return MAIL_INTEGRATIONS.has(integrationId);
}

const accountParam = {
  type: 'string',
  description: 'Which connected mailbox to use (its email address). Needed only when more than one is connected.',
};
const folderParam = { type: 'string', description: 'Mailbox folder path, default INBOX. list_folders gives the paths.' };

function toolList(serviceName: string, accounts: readonly MailAccount[]): Tool[] {
  const connected = accounts.map((account) => account.email).join(', ') || 'none';
  const intro = `${serviceName} (connected: ${connected}).`;
  return [
    {
      name: 'search_mail',
      description: `${intro} Search a folder and return the newest matching messages (uid, date, from, to, subject, unread). Use read_mail with a uid for the body.`,
      inputSchema: {
        type: 'object',
        properties: {
          account: accountParam,
          folder: folderParam,
          text: { type: 'string', description: 'Words that appear in the subject, sender, recipient or body.' },
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          since: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
          before: { type: 'string', description: 'YYYY-MM-DD, exclusive.' },
          unread_only: { type: 'boolean' },
          limit: { type: 'number', description: 'At most this many, newest first (default 20, max 100).' },
        },
      },
    },
    {
      name: 'read_mail',
      description: `${intro} Read one message: headers, plain-text body (long bodies are cut at 20,000 characters) and the list of attachments. Marks it as read.`,
      inputSchema: {
        type: 'object',
        properties: { account: accountParam, folder: folderParam, uid: { type: 'number' } },
        required: ['uid'],
      },
    },
    {
      name: 'send_mail',
      description: `${intro} Send a plain-text message from the connected address. To reply, pass the original message's messageId (from read_mail) as in_reply_to. Sending cannot be undone: confirm the recipients and text with the person first unless they already told you to send.`,
      inputSchema: {
        type: 'object',
        properties: {
          account: accountParam,
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          text: { type: 'string' },
          in_reply_to: { type: 'string' },
        },
        required: ['to', 'subject', 'text'],
      },
    },
    {
      name: 'list_folders',
      description: `${intro} List the mailbox folders (Inbox, Sent, custom folders) with their paths.`,
      inputSchema: { type: 'object', properties: { account: accountParam } },
    },
  ];
}

function pickAccount(accounts: readonly MailAccount[], requested: unknown, serviceName: string): MailAccount {
  if (accounts.length === 0) throw new Error(`No ${serviceName} mailbox is connected in Gugu any more; connect one in the library.`);
  if (typeof requested === 'string' && requested.trim()) {
    const wanted = requested.trim().toLowerCase();
    const found = accounts.find((account) => account.email.toLowerCase() === wanted);
    if (!found) {
      throw new Error(`${requested} is not a connected ${serviceName} mailbox. Connected: ${accounts.map((a) => a.email).join(', ')}.`);
    }
    return found;
  }
  if (accounts.length > 1) {
    throw new Error(`More than one ${serviceName} mailbox is connected (${accounts.map((a) => a.email).join(', ')}); say which with "account".`);
  }
  return accounts[0]!;
}

/** 收件人一格:没给 = 空;给了就必须是一串地址 —— 写错的那一个 ❌ 悄悄丢掉、照样发出去。 */
function recipients(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list)) throw new Error(`${field} must be a list of email addresses.`);
  return list.map((entry) => {
    if (typeof entry !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(entry.trim().replace(/^.*<([^>]+)>$/, '$1'))) {
      throw new Error(`${field} has something that is not an email address: ${JSON.stringify(entry)}. Nothing was sent.`);
    }
    return entry.trim();
  });
}
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function asResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function mailIntegrationTools(
  serviceName: string,
  /** 这一家现在连着的每个邮箱(每次调用现读)。 */
  loadAccounts: () => Promise<unknown[]>
): LocalIntegrationTools {
  const accounts = async (): Promise<MailAccount[]> =>
    (await loadAccounts()).flatMap((credentials) => {
      const parsed = mailAccountSchema.safeParse(credentials);
      return parsed.success ? [parsed.data] : [];
    });

  return {
    async list() {
      return toolList(serviceName, await accounts());
    },
    async call(name, args) {
      try {
        const account = pickAccount(await accounts(), args.account, serviceName);
        switch (name) {
          case 'search_mail':
            return asResult(
              await searchMail(account, {
                folder: optionalString(args.folder),
                text: optionalString(args.text),
                from: optionalString(args.from),
                to: optionalString(args.to),
                subject: optionalString(args.subject),
                since: optionalString(args.since),
                before: optionalString(args.before),
                unreadOnly: args.unread_only === true,
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
              })
            );
          case 'read_mail': {
            const uid = Number(args.uid);
            if (!Number.isInteger(uid) || uid <= 0) throw new Error('uid must be a message uid from search_mail.');
            return asResult(await readMail(account, { folder: optionalString(args.folder), uid }));
          }
          case 'send_mail': {
            const subject = optionalString(args.subject);
            const text = typeof args.text === 'string' ? args.text : '';
            if (!subject) throw new Error('subject is empty.');
            if (!text.trim()) throw new Error('text is empty.');
            return asResult(
              await sendMail(account, {
                to: recipients(args.to, 'to'),
                cc: recipients(args.cc, 'cc'),
                bcc: recipients(args.bcc, 'bcc'),
                subject,
                text,
                inReplyTo: optionalString(args.in_reply_to),
              })
            );
          }
          case 'list_folders':
            return asResult(await listMailFolders(account));
          default:
            throw new Error(`Unknown tool ${name}.`);
        }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
      }
    },
  };
}
