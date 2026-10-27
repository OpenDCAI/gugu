import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyNotionCredentials } from './client';
import { icon } from './icon';
import { NOTION_MCP_URL } from './types';

const plugin = defineIntegrationPlugin(
  {
    id: 'notion',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://www.notion.so',
    abilities: [
      { en: 'Search and read pages and databases', 'zh-CN': '搜索、读取页面和数据库' },
      { en: 'Create and update pages', 'zh-CN': '新建、更新页面' },
    ],
    playbooks: [
      {
        title: { en: 'Find a page', 'zh-CN': '找一页' },
        prompt: {
          en: 'Find my Notion page about the product roadmap and summarize what is planned next.',
          'zh-CN': '在 Notion 里找到产品路线图那一页，总结接下来要做什么。',
        },
      },
      {
        title: { en: 'Capture notes', 'zh-CN': '记一页笔记' },
        prompt: {
          en: 'Create a Notion page "Ideas" with three ideas from our conversation.',
          'zh-CN': '新建一页 Notion「想法」，把我们刚聊的三个点记进去。',
        },
      },
    ],
  },
  {
    auth: {
      // Notion's hosted MCP only accepts OAuth. Authorizing in the browser
      // replaces pasting an integration token and sharing every page with it.
      methods: [{ kind: 'mcp-oauth', serverUrl: NOTION_MCP_URL }],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyNotionCredentials(credentials);
      if (!result.success) return { connected: false, error: result.error };
      return { connected: true };
    },
  },
});
