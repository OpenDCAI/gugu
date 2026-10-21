import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyFeaturebaseCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'featurebase',
    name: 'Featurebase',
    description: { en: 'Work on Featurebase posts', 'zh-CN': '处理 Featurebase 帖子' },
    websiteUrl: 'https://www.featurebase.app',
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
              placeholder: { en: 'Featurebase API key', 'zh-CN': 'Featurebase API 密钥' },
            },
          ],
          help: { en: 'Create an API key in Featurebase dashboard settings.', 'zh-CN': '在 Featurebase 控制台的设置里新建一个 API 密钥。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyFeaturebaseCredentials(credentials);
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
