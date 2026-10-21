import type { LocalizedText } from '../../localized-text';
import type { IntegrationPlaybook } from '../../plugin';

/** 三家邮箱(QQ / 网易 / 企业邮箱)连上以后 agent 能做的事,一样。 */
export const MAIL_ABILITIES: LocalizedText[] = [
  { en: 'Search mail by sender, subject, date or words in it', 'zh-CN': '按发件人、主题、日期或内容查邮件' },
  { en: 'Read a message, with its attachments listed', 'zh-CN': '读一封邮件的正文，列出附件' },
  { en: 'Send and reply from this address', 'zh-CN': '用这个地址发信、回信' },
];

export const MAIL_PLAYBOOKS: IntegrationPlaybook[] = [
  {
    title: { en: 'Unread digest', 'zh-CN': '未读邮件摘要' },
    prompt: {
      en: 'Go through my unread mail from the last 3 days and give me a short digest: who wrote, what they want, and what needs a reply.',
      'zh-CN': '看一下我最近 3 天的未读邮件，给我一份简短摘要：谁来的信、要我做什么、哪些需要回复。',
    },
  },
  {
    title: { en: 'Find a message', 'zh-CN': '找一封信' },
    prompt: {
      en: 'Find the latest email about an invoice or a receipt and tell me what it says.',
      'zh-CN': '帮我找最近一封关于发票或收据的邮件，告诉我里面写了什么。',
    },
  },
  {
    title: { en: 'Draft a reply', 'zh-CN': '起草回信' },
    prompt: {
      en: 'Read my most recent email that asks me something and draft a polite reply. Show me the draft before sending.',
      'zh-CN': '读我最近一封向我提问的邮件，起草一封得体的回信，发出去之前先给我看。',
    },
  },
];
