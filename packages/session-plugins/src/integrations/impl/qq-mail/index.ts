import { summary } from './summary';
import { MAIL_ABILITIES, MAIL_PLAYBOOKS } from '../../helpers/mail/mail-copy';
import { verifyMailCredentials } from '../../helpers/mail/mail-verify';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * QQ 邮箱(#7240):IMAP 收、SMTP 发,用授权码登录。一个地址一个账号,可以连多个。
 */
const plugin = defineIntegrationPlugin(
  {
    id: 'qq-mail',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://mail.qq.com',
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
              placeholder: { en: 'name@qq.com', 'zh-CN': 'name@qq.com' },
            },
            {
              id: 'password',
              label: { en: 'Authorization code', 'zh-CN': '授权码' },
              secret: true,
              placeholder: { en: 'Authorization code (not the login password)', 'zh-CN': '授权码（不是登录密码）' },
            },
          ],
          help: {
            en: 'In QQ Mail on the web: Settings → Account and security → turn on IMAP/SMTP, then generate an authorization code.',
            'zh-CN': 'QQ 邮箱网页版 → 设置 → 账号与安全 → 安全设置，开启「IMAP/SMTP 服务」后生成授权码。',
          },
          helpUrl: 'https://service.mail.qq.com/detail/0/75',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyMailCredentials('qq', credentials),
  },
});
