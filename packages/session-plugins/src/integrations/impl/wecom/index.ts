import { verifyCliConnectionRecord } from '../../helpers/cli-connection';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 企业微信官方命令行 `wecom-cli`(github.com/WecomTeam/wecom-cli,MIT):消息、邮件、文档、表格、待办、日程、会议、
 * 微盘、通讯录。登录 = 用企业微信扫码,为你绑定一个智能机器人,agent 以它的身份操作(`wecom-cli auth init`)。
 */
const plugin = defineIntegrationPlugin(
  {
    id: 'wecom',
    name: '企业微信',
    description: {
      en: 'WeCom messages, docs, calendar, to-dos and meetings',
      'zh-CN': '企业微信的消息、文档、日程、待办和会议',
    },
    websiteUrl: 'https://work.weixin.qq.com',
    abilities: [
      { en: 'Send messages and files to chats', 'zh-CN': '给会话发消息、发文件' },
      { en: 'Docs, sheets and smart sheets', 'zh-CN': '文档、表格和智能表格' },
      { en: 'Calendar, meetings and to-dos', 'zh-CN': '日程、会议和待办' },
      { en: 'Search the company directory', 'zh-CN': '搜索通讯录' },
    ],
    playbooks: [
      {
        title: { en: 'Schedule a meeting', 'zh-CN': '约个会' },
        prompt: {
          en: 'Book a 30-minute WeCom meeting with me tomorrow afternoon titled "Weekly sync" and send me the link.',
          'zh-CN': '在企业微信上帮我约明天下午 30 分钟的会，主题「周例会」，把会议链接发我。',
        },
      },
      {
        title: { en: 'My WeCom to-dos', 'zh-CN': '企业微信待办' },
        prompt: {
          en: 'List my open WeCom to-dos and mark the ones I finished today as done.',
          'zh-CN': '列出我企业微信里没完成的待办，把今天做完的标记为完成。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [
        {
          kind: 'cli',
          tool: 'wecom-cli',
          login: 'qr-code',
          prerequisite: {
            text: {
              en: 'Scan with the WeCom app. WeCom creates a smart bot for you, and agents act as that bot.',
              'zh-CN': '用企业微信扫码。企业微信会为你创建一个智能机器人，agent 以它的身份操作。',
            },
          },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials) {
      return verifyCliConnectionRecord(plugin.metadata.name, 'wecom-cli', credentials);
    },
  },
});
