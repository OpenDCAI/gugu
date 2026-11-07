import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { summary } from './summary';
import { icon } from './icon';

export const BAIDU_PAN_MCP_URL = 'https://mcp-pan.baidu.com/sse';
export const BAIDU_PAN_APP_FOLDER = '/apps/咕咕';

const plugin = defineIntegrationPlugin({
  id: 'baidu-pan',
    catalog: summary.catalog,
  name: summary.name['zh-CN'],
  description: summary.description,
  websiteUrl: 'https://pan.baidu.com',
  abilities: [{ en: 'Read and write files in /apps/咕咕', 'zh-CN': '读写 /apps/咕咕 中的文件' }],
  playbooks: [{
    title: { en: 'List the app folder', 'zh-CN': '查看咕咕文件夹' },
    prompt: {
      en: 'List the files in /apps/咕咕 in Baidu Netdisk.',
      'zh-CN': '列出百度网盘 /apps/咕咕 文件夹里的文件。',
    },
  }],
}, {
  auth: { methods: [{
    kind: 'mcp-oauth', serverUrl: BAIDU_PAN_MCP_URL, transport: 'sse',
    registration: 'pre-registered', custody: 'platform',
    help: {
      en: 'Scan the QR code to authorize Gugu. It can only access the “咕咕” folder in Baidu Netdisk (/apps/咕咕).',
      'zh-CN': '扫码授权咕咕，只能访问百度网盘里的「咕咕」文件夹（/apps/咕咕）。',
    },
  }] },
}, { icon });

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: { verify: async () => ({ connected: false, error: {
    type: 'auth_failed', message: 'Authorize Baidu Netdisk through the Gugu platform.',
  } }) },
});
