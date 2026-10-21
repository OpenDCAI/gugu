import { CloudComputerError, cloudComputerBaseUrl } from '@gugu/core/cloud/cloudComputer'
import { createChatChannelsClient, type ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { authBoundedFetch } from './authBoundedFetch'
import { getRendererAccessToken } from './sessionPublication'

/**
 * #7199 渲染层到「聊天渠道」的那一条:和云电脑同一扇门(管家的 /channels),地址、令牌、登录态边界都照
 * `rendererCloudComputerClient`。拿不到地址 = null ⇒ 设置 → 聊天渠道说「暂未开放」。
 */
function overrideUrl(): string {
  return typeof __GUGU_CLOUD_COMPUTER_URL__ === 'string' ? __GUGU_CLOUD_COMPUTER_URL__ : ''
}

function supabaseUrlOrNull(): string | null {
  try {
    return getSupabaseUrl()
  } catch {
    return null
  }
}

let cached: { baseUrl: string; client: ChatChannelsClient } | null = null

export function rendererChatChannelsClient(): ChatChannelsClient | null {
  const baseUrl = cloudComputerBaseUrl({ enabled: cloudComputerEnabled(), override: overrideUrl(), supabaseUrl: supabaseUrlOrNull() })
  if (!baseUrl) return null
  if (cached?.baseUrl === baseUrl) return cached.client
  const client = createChatChannelsClient({
    baseUrl,
    accessToken: async () => {
      const token = getRendererAccessToken()
      if (!token) throw new CloudComputerError(0, 'unauthorized', 'Not authenticated')
      return token
    },
    anonKey: getSupabaseAnonKey(),
    fetch: authBoundedFetch,
  })
  cached = { baseUrl, client }
  return client
}
