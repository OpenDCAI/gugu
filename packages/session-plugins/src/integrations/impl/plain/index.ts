import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyPlainCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'plain',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://www.plain.com',
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
              secret: true,
              required: true,
              placeholder: { en: 'Plain API key', 'zh-CN': 'Plain API 密钥' },
            },
          ],
          help: { en: 'Create an API key from Plain settings.', 'zh-CN': '在 Plain 设置里新建一个 API 密钥。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyPlainCredentials(credentials);
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
