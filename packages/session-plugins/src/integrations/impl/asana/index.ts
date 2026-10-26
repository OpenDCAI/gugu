import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyAsanaCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'asana',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://asana.com',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'accessToken',
              label: { en: 'Personal access token', 'zh-CN': '个人访问令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'Asana personal access token', 'zh-CN': 'Asana 个人访问令牌' },
            },
          ],
          help: { en: 'Open Asana and go to My Settings > Apps, click on Developer Apps and create a new Personal Access Token.', 'zh-CN': '打开 Asana，进入「我的设置 > 应用」，点「开发者应用」，新建一个个人访问令牌。' },
          helpUrl: 'https://developers.asana.com/docs/personal-access-token',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyAsanaCredentials(credentials);
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
