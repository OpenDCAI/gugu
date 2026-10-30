import { cloudComputerBaseUrl } from '@gugu/core/cloud/cloudComputer';
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config';
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices';
import { createPlatformIntegrationsClient } from '@gugu/core/cloud/platformIntegrations';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { log } from '@main/lib/logger';
import { PlatformCredentialService, platformCustodyProviders } from './platform-credentials';

/**
 * #921 这台机器上的「平台保管的凭据」。与聊天渠道同一扇门(云电脑管家,用户自己的令牌);
 * 云电脑上跑的是同一份主进程(无窗口),令牌由它自己的登录态给,所以那边照样经转发口用。
 */
export const platformCredentials = new PlatformCredentialService({
  client: () => {
    const baseUrl = cloudComputerBaseUrl({
      enabled: cloudComputerEnabled(),
      override: process.env.GUGU_CLOUD_COMPUTER_URL ?? null,
      supabaseUrl: getSupabaseUrl(),
    });
    if (!baseUrl) return null;
    return createPlatformIntegrationsClient({
      baseUrl,
      anonKey: getSupabaseAnonKey(),
      // 每次请求现取:令牌会续期,❌ 记住一份。
      accessToken: async () => {
        const token = await currentAccountAccessToken();
        if (!token) throw new Error('This machine is not signed in to Gugu.');
        return token;
      },
    });
  },
  accounts: providerAccountRegistry,
  providers: platformCustodyProviders,
  log,
});
