import { summary } from './summary';
import { MAIL_ABILITIES, MAIL_PLAYBOOKS } from '../../helpers/mail/mail-copy';
import { verifyMailCredentials } from '../../helpers/mail/mail-verify';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 企业邮箱(#7240):腾讯企业邮、网易企业邮、阿里邮箱……都是 IMAP / SMTP,服务器由用户填(默认腾讯企业邮)。
 * `host:port` 可以写端口;不写 = 993 / 465 直接 SSL。
 */
const plugin = defineIntegrationPlugin(
  {
    id: 'enterprise-mail',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://exmail.qq.com',
    abilities: MAIL_ABILITIES,
    playbooks: MAIL_PLAYBOOKS,
    multiAccount: true,
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'email',
              label: { en: 'Email address', 'zh-CN': '邮箱地址' },
              placeholder: { en: 'name@company.com', 'zh-CN': 'name@company.com' },
            },
            {
              id: 'password',
              label: { en: 'Password or client-specific password', 'zh-CN': '密码或客户端专用密码' },
              secret: true,
              placeholder: { en: 'Password or client-specific password', 'zh-CN': '密码或客户端专用密码' },
            },
            {
              id: 'imapHost',
              label: { en: 'IMAP server', 'zh-CN': 'IMAP 服务器' },
              defaultValue: 'imap.exmail.qq.com',
              placeholder: { en: 'imap.exmail.qq.com', 'zh-CN': 'imap.exmail.qq.com' },
            },
            {
              id: 'smtpHost',
              label: { en: 'SMTP server', 'zh-CN': 'SMTP 服务器' },
              defaultValue: 'smtp.exmail.qq.com',
              placeholder: { en: 'smtp.exmail.qq.com', 'zh-CN': 'smtp.exmail.qq.com' },
            },
          ],
          help: {
            en: 'Tencent Exmail is filled in. For NetEase use imap.qiye.163.com / smtp.qiye.163.com, for Alibaba imap.qiye.aliyun.com / smtp.qiye.aliyun.com. If the company turned on secure login, use a client-specific password.',
            'zh-CN': '已填好腾讯企业邮的服务器。网易企业邮填 imap.qiye.163.com / smtp.qiye.163.com，阿里邮箱填 imap.qiye.aliyun.com / smtp.qiye.aliyun.com。开了安全登录的，用客户端专用密码。',
          },
          helpUrl: 'https://service.exmail.qq.com/cgi-bin/help?subtype=1&&id=28&&no=1001256',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyMailCredentials('enterprise', credentials),
  },
});
