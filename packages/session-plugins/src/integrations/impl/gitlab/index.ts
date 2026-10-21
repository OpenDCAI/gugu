import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyGitLabCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'gitlab',
    name: 'GitLab',
    description: { en: 'Work on GitLab issues', 'zh-CN': '处理 GitLab issue' },
    websiteUrl: 'https://gitlab.com',
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
              placeholder: { en: 'https://gitlab.com', 'zh-CN': 'https://gitlab.com' },
              defaultValue: 'https://gitlab.com',
            },
            {
              id: 'apiToken',
              label: { en: 'Personal access token', 'zh-CN': '个人访问令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'Personal access token', 'zh-CN': '个人访问令牌' },
            },
          ],
          help: { en: 'Create a personal access token with read_api scope in GitLab settings.', 'zh-CN': '在 GitLab 设置里新建一个带 read_api 权限的个人访问令牌。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyGitLabCredentials(credentials);
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
