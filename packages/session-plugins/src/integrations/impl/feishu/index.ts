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
          en: 'Scan with Feishu to authorize',
          'zh-CN': '用飞书扫码授权',
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
