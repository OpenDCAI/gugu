import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyJiraCredentials } from './client';
import { icon } from './icon';

const plugin = defineIntegrationPlugin(
  {
    id: 'jira',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://www.atlassian.com/software/jira',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'siteUrl',
              label: { en: 'Site URL', 'zh-CN': '站点地址' },
              required: true,
              placeholder: { en: 'https://your-domain.atlassian.net', 'zh-CN': 'https://your-domain.atlassian.net' },
            },
            {
              id: 'email',
              label: { en: 'Email', 'zh-CN': '邮箱' },
              required: true,
              placeholder: { en: 'you@example.com', 'zh-CN': 'you@example.com' },
            },
            {
              id: 'apiToken',
              label: { en: 'API token', 'zh-CN': 'API 令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'Jira API token', 'zh-CN': 'Jira API 令牌' },
            },
          ],
          help: { en: 'Create an API token from your Atlassian account security settings.', 'zh-CN': '在 Atlassian 账号的安全设置里新建一个 API 令牌。' },
          helpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyJiraCredentials(credentials);
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
