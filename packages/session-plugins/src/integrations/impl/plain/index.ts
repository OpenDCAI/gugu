import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyPlainCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'plain',
    name: 'Plain',
    description: { en: 'Work on Plain threads', 'zh-CN': '处理 Plain 客服对话' },
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
