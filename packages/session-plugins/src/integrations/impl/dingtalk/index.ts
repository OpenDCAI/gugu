import { verifyCliConnectionRecord } from '../../helpers/cli-connection';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 钉钉官方命令行 `dws`(github.com/DingTalk-Real-AI/dingtalk-workspace-cli,Apache-2.0)。钉钉的云端 MCP
 * 只认链接里的密钥、没有浏览器授权,所以走它:通讯录、群聊、日程、待办、审批、文档、云盘、AI 表格……
 * 登录用设备流(`dws auth login --device`):给一个链接和授权码,在钉钉里确认 —— 本机、远程 server、云电脑一样走。
 * ⚠️ 组织管理员要先在开放平台开「CLI 访问」;没开的话,钉钉的授权页上能点「立即申请」通知管理员。
 */
const plugin = defineIntegrationPlugin(
  {
    id: 'dingtalk',
    name: '钉钉',
    description: {
      en: 'DingTalk contacts, chats, calendar, to-dos, approvals and docs',
      'zh-CN': '钉钉的通讯录、群聊、日程、待办、审批和文档',
    },
    websiteUrl: 'https://www.dingtalk.com',
    abilities: [
      { en: 'Look up colleagues and departments', 'zh-CN': '查同事、查部门' },
      { en: 'Read chats and send messages', 'zh-CN': '看群聊、发消息' },
      { en: 'Calendar, to-dos and approvals', 'zh-CN': '日程、待办和审批' },
      { en: 'Docs and DingTalk drive', 'zh-CN': '文档和钉盘' },
    ],
    playbooks: [
      {
        title: { en: 'My day on DingTalk', 'zh-CN': '今天的钉钉' },
        prompt: {
          en: 'What is on my DingTalk calendar today, and which to-dos are due?',
          'zh-CN': '我今天钉钉日程上有什么，哪些待办到期了？',
        },
      },
      {
        title: { en: 'Pending approvals', 'zh-CN': '待我审批' },
        prompt: {
          en: 'List the approvals waiting for me on DingTalk and summarize each in one line.',
          'zh-CN': '列出钉钉上等我审批的单子，每个用一句话说清楚。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [
        {
          kind: 'cli',
          tool: 'dws',
          login: 'device-link',
          prerequisite: {
            text: {
              en: 'Your organization admin must first turn on CLI access: DingTalk Developer Platform → CLI Access Management → Enable. If it is off, the DingTalk page lets you send the admin a request.',
              'zh-CN': '需要组织管理员先开启「CLI 访问」：钉钉开发者后台 → CLI 访问管理 → 开启。没开的话，授权页上可以点「立即申请」通知管理员。',
            },
            url: 'https://open-dev.dingtalk.com',
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
      return verifyCliConnectionRecord(plugin.metadata.name, 'dws', credentials);
    },
  },
});
