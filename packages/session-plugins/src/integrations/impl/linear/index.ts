import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyLinearCredentials } from './client';
import { icon } from './icon';
import { LINEAR_MCP_URL } from './types';

const plugin = defineIntegrationPlugin(
  {
    id: 'linear',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://linear.app',
    abilities: [
      { en: 'Search, read and create issues', 'zh-CN': '搜索、读取、新建工单' },
      { en: 'Update status and assignees', 'zh-CN': '改状态、改负责人' },
    ],
    playbooks: [
      {
        title: { en: 'My open issues', 'zh-CN': '我手上的工单' },
        prompt: {
          en: 'List my open Linear issues by priority and tell me which are blocked.',
          'zh-CN': '按优先级列出我在 Linear 上没关的工单，告诉我哪些卡住了。',
        },
      },
      {
        title: { en: 'File a bug', 'zh-CN': '提一个 bug' },
        prompt: {
          en: 'File a Linear issue for the bug I describe next, with steps to reproduce.',
          'zh-CN': '把我接下来描述的问题提成 Linear 工单，写清复现步骤。',
        },
      },
    ],
  },
  {
    auth: {
      // 在浏览器里授权,❌ 不再让用户去 Linear 后台生成 personal API key 再粘回来
      // (owner 2026-09-15:「Linear 不是说类似的不用 apikey 来连接吗,而是通过网页授权」)。
      // Linear 的托管 MCP 支持 OAuth 2.1 + 动态客户端注册,和 Notion 同一条通路。
      methods: [{ kind: 'mcp-oauth', serverUrl: LINEAR_MCP_URL }],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyLinearCredentials(credentials);
      if (!result.success) return { connected: false, error: result.error };
      return { connected: true };
    },
  },
});
