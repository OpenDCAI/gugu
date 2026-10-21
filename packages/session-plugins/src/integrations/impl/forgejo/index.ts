import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyForgejoCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'forgejo',
    name: 'Forgejo',
    description: { en: 'Work on Forgejo issues', 'zh-CN': '处理 Forgejo issue' },
    websiteUrl: 'https://forgejo.org',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'instanceUrl',
              label: { en: 'Instance URL', 'zh-CN': '实例地址' },
              required: true,
              placeholder: { en: 'https://forgejo.example.com', 'zh-CN': 'https://forgejo.example.com' },
            },
            {
              id: 'apiToken',
              label: { en: 'API token', 'zh-CN': 'API 令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'API token', 'zh-CN': 'API 令牌' },
            },
          ],
          help: { en: 'Create an API token in your Forgejo user settings under Applications.', 'zh-CN': '在 Forgejo 用户设置的「应用」里新建一个 API 令牌。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyForgejoCredentials(credentials);
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
