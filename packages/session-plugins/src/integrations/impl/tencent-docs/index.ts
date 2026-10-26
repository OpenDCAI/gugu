import { summary } from './summary';
import { verifyHostedMcpCredentials } from '../../helpers/hosted-mcp';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 腾讯文档官方的云端 MCP:浏览器授权、自动注册客户端、能续期;建文档 / 表格 / 幻灯片 / 思维导图,
 * 搜索、读取、改表格。它的受保护资源元数据只写在 401 的 `WWW-Authenticate` 头里(默认位置都是 404),
 * 授权流程先读那个头,才拿得到它要的权限范围(见 mcp-oauth-flow 的 probeProtectedResource)。
 * 另有一条「个人令牌」路线,❌ 不走:浏览器授权就够了,不让用户填 key。
 */
export const TENCENT_DOCS_MCP_URL = 'https://docs.qq.com/openapi/mcp';

const plugin = defineIntegrationPlugin(
  {
    id: 'tencent-docs',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://docs.qq.com',
    abilities: [
      { en: 'Create, read and edit Tencent Docs', 'zh-CN': '新建、读取和编辑腾讯文档' },
      { en: 'Work with online sheets', 'zh-CN': '读写在线表格' },
    ],
    playbooks: [
      {
        title: { en: 'Draft a doc', 'zh-CN': '起草一篇文档' },
        prompt: {
          en: 'Create a Tencent Doc titled "Weekly plan" with this week\'s priorities as a checklist.',
          'zh-CN': '新建一篇腾讯文档《本周计划》，把本周要做的事列成清单。',
        },
      },
      {
        title: { en: 'Tidy a sheet', 'zh-CN': '整理表格' },
        prompt: {
          en: 'Open my latest Tencent Docs sheet and tell me what columns it has and what looks inconsistent.',
          'zh-CN': '打开我最近的一张腾讯文档表格，告诉我它有哪些列、哪里看起来不一致。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [{ kind: 'mcp-oauth', serverUrl: TENCENT_DOCS_MCP_URL }],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyHostedMcpCredentials(plugin.metadata.name, credentials),
  },
});
