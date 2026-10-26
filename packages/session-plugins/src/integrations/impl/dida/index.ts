import { summary } from './summary';
import { verifyHostedMcpCredentials } from '../../helpers/hosted-mcp';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 滴答清单官方的云端 MCP:浏览器授权、自动注册客户端;读写任务。
 * ⚠️ 它的授权服务只声明 `authorization_code`,不发续期令牌 ⇒ 令牌到期后咕咕续不上,
 * 集成页如实显示「授权已失效,请重新连接」(product spec「续不上时」),❌ 显示成还连着。
 */
export const DIDA_MCP_URL = 'https://mcp.dida365.com';

const plugin = defineIntegrationPlugin(
  {
    id: 'dida',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://dida365.com',
    abilities: [
      { en: 'Add, update and complete tasks', 'zh-CN': '添加、修改、完成任务' },
      { en: 'Read lists and due dates', 'zh-CN': '查看清单和截止时间' },
    ],
    playbooks: [
      {
        title: { en: 'Today\'s tasks', 'zh-CN': '今天要做什么' },
        prompt: {
          en: 'List my Dida tasks due today and suggest an order to do them.',
          'zh-CN': '列出我滴答清单里今天到期的任务，帮我排个先后顺序。',
        },
      },
      {
        title: { en: 'Capture to-dos', 'zh-CN': '把待办记下来' },
        prompt: {
          en: 'Add these to my Dida inbox: buy printer paper, reply to the landlord, book a dentist appointment.',
          'zh-CN': '把这几件事加到我的滴答收集箱：买打印纸、回复房东、约牙医。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [{ kind: 'mcp-oauth', serverUrl: DIDA_MCP_URL }],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyHostedMcpCredentials(plugin.metadata.name, credentials),
  },
});
