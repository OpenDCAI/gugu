import { summary } from './summary';
import { verifyCliConnectionRecord } from '../../helpers/cli-connection';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/** 飞书官方 CLI：应用配置和个人授权由宿主驱动，工具与 Skills 只注入咕咕会话。 */
const plugin = defineIntegrationPlugin(
  {
    id: 'feishu',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://www.feishu.cn',
    abilities: [
      { en: 'Read and write Feishu docs and wiki pages', 'zh-CN': '读写飞书云文档和知识库' },
      { en: 'Search messages and contacts', 'zh-CN': '搜索消息和通讯录' },
      { en: 'Send messages to chats', 'zh-CN': '往群里、给同事发消息' },
    ],
    playbooks: [
      {
        title: { en: 'Summarize a doc', 'zh-CN': '总结一篇文档' },
        prompt: {
          en: 'Find my most recently edited Feishu doc and summarize it in five bullet points.',
          'zh-CN': '找到我最近编辑的一篇飞书文档，用五条要点总结它。',
        },
      },
      {
        title: { en: 'Meeting notes to doc', 'zh-CN': '会议纪要成文' },
        prompt: {
          en: 'Write the notes of today\'s meeting into a new Feishu doc with decisions and owners.',
          'zh-CN': '把今天的会议纪要整理成一篇新的飞书文档，写清结论和负责人。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [{
        kind: 'cli', tool: 'lark-cli', login: 'qr-code',
        prerequisite: { text: {
          en: 'First configure your Feishu app, then authorize your personal account. Follow both links or QR codes in order. Existing MCP connections need to reconnect.',
          'zh-CN': '先按引导配置你自己的飞书应用，再授权个人账号；依次完成两次链接或扫码确认。原有 MCP 连接需要重新连接。',
        } },
      }],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => Promise.resolve(verifyCliConnectionRecord(plugin.metadata.name, 'lark-cli', credentials)),
  },
});
