import { summary } from './summary';
import { MAIL_ABILITIES, MAIL_PLAYBOOKS } from '../../helpers/mail/mail-copy';
import { verifyMailCredentials } from '../../helpers/mail/mail-verify';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 网易邮箱(#7240):163 / 126 / yeah.net,服务器按地址的域名选。网易要求客户端报上名字(IMAP ID),
 * 否则拒绝登录(「Unsafe Login」),由 mail-client 的 clientInfo 负责。
 */
const plugin = defineIntegrationPlugin(
  {
    id: 'netease-mail',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://mail.163.com',
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
              placeholder: { en: 'name@163.com', 'zh-CN': 'name@163.com' },
            },
            {
              id: 'password',
              label: { en: 'Authorization code', 'zh-CN': '授权码' },
              secret: true,
              placeholder: { en: 'Authorization code (not the login password)', 'zh-CN': '授权码（不是登录密码）' },
            },
          ],
          help: {
            en: 'In NetEase Mail on the web: Settings → POP3/SMTP/IMAP → turn on IMAP/SMTP and follow the steps to get an authorization code.',
            'zh-CN': '网易邮箱网页版 → 设置 → POP3/SMTP/IMAP，开启「IMAP/SMTP 服务」，按提示验证后得到授权码。',
          },
          helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyMailCredentials('netease', credentials),
  },
});
