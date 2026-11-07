import { cloudComputerBaseUrl } from '@gugu/core/cloud/cloudComputer'
import { createPlatformIntegrationsClient } from '@gugu/core/cloud/platformIntegrations'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { ConnectionError } from '@gugu/core/cloud/connections'
import { authBoundedFetch } from './authBoundedFetch'
import { getRendererAccessToken } from './sessionPublication'

/** The same credential service and JWT on desktop and phone. No host selection. */
export function rendererPlatformIntegrationsClient() {
  const baseUrl = cloudComputerBaseUrl({ enabled: cloudComputerEnabled(),
    override: typeof __GUGU_CLOUD_COMPUTER_URL__ === 'string' ? __GUGU_CLOUD_COMPUTER_URL__ : '',supabaseUrl: getSupabaseUrl() })
  if (!baseUrl) throw new ConnectionError('platform-unavailable','CONNECTION_PLATFORM_UNAVAILABLE')
  return createPlatformIntegrationsClient({ baseUrl,anonKey: getSupabaseAnonKey(),fetch: authBoundedFetch,
    accessToken: async () => {
      const token = getRendererAccessToken()
      if (!token) throw new ConnectionError('signed-out','CONNECTION_SIGNED_OUT')
      return token
    },
  })
}
