import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyTrelloCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'trello',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://trello.com',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'apiKey',
              label: { en: 'API key', 'zh-CN': 'API 密钥' },
              required: true,
              placeholder: { en: 'API key', 'zh-CN': 'API 密钥' },
            },
            {
              id: 'apiToken',
              label: { en: 'API token', 'zh-CN': 'API 令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'API token', 'zh-CN': 'API 令牌' },
            },
          ],
          help: { en: 'Create a Power-Up at trello.com/power-ups/admin to get an API key, then generate a token from the API key page.', 'zh-CN': '在 trello.com/power-ups/admin 新建一个 Power-Up 拿到 API 密钥，再在 API 密钥那一页生成令牌。' },
          helpUrl: 'https://trello.com/power-ups/admin',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyTrelloCredentials(credentials);
      if (!result.success)
        return {
          connected: false,
          error: result.error,
        };
      return {
        connected: true,
        ...result.data,
      };
    },
  },
});
