import { summary } from './summary';
import type { VerifyResult } from '../../capabilities/auth';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { verifyPlaneCredentials } from './client';
import { icon } from './icon';
import { PLANE_CLOUD_API_BASE_URL } from './types';

const plugin = defineIntegrationPlugin(
  {
    id: 'plane',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://plane.so',
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'apiBaseUrl',
              label: { en: 'API base URL', 'zh-CN': 'API 根地址' },
              required: true,
              placeholder: { en: PLANE_CLOUD_API_BASE_URL, 'zh-CN': PLANE_CLOUD_API_BASE_URL },
              defaultValue: PLANE_CLOUD_API_BASE_URL,
            },
            {
              id: 'workspaceSlug',
              label: { en: 'Workspace slug', 'zh-CN': '工作区标识（slug）' },
              required: true,
              placeholder: { en: 'Workspace slug', 'zh-CN': '工作区标识' },
            },
            {
              id: 'apiKey',
              label: { en: 'API key', 'zh-CN': 'API 密钥' },
              secret: true,
              required: true,
              placeholder: { en: 'Plane API key', 'zh-CN': 'Plane API 密钥' },
            },
          ],
          help: { en: 'For Plane Cloud, use the default API base URL. For self-hosted Plane, enter your instance API base URL.', 'zh-CN': '用 Plane Cloud 就保留默认的 API 根地址；自建的 Plane 填你自己实例的 API 根地址。' },
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    async verify(_host, credentials): Promise<VerifyResult> {
      const result = await verifyPlaneCredentials(credentials);
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
