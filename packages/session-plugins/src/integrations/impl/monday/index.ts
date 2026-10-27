import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyMondayCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'monday',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://monday.com',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'apiToken',
              label: { en: 'API token', 'zh-CN': 'API 令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'API token', 'zh-CN': 'API 令牌' },
            },
          ],
          help: { en: 'Generate a token from Monday.com Admin API settings.', 'zh-CN': '在 Monday.com 管理后台的 API 设置里生成一个令牌。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyMondayCredentials(credentials);
      if (!result.success) return { connected: false, error: result.error };
      return { connected: true, ...result.data };
    },
  },
});
