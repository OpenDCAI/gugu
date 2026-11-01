const PROXY_ENV_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']
const INVALID_PROXY_ERROR = 'Invalid HTTP proxy configuration'
const PROXY_SETUP_ERROR = 'Failed to configure HTTP proxy'

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROXY_ENV_NAMES) {
    const value = env[name]?.trim()
    if (value) return value
  }
  return undefined
}

export function redactProxyUrl(raw: unknown): string {
  try {
    const url = new URL(String(raw ?? ''))
    if (!url.host || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '[invalid proxy URL]'
    return `${url.protocol}//${url.host}`
  } catch {
    return '[invalid proxy URL]'
  }
}

export async function configureEnvHttpProxy(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): Promise<string | undefined> {
  const proxyUrl = readProxyEnv(env)
  if (!proxyUrl) return undefined

  const safeUrl = redactProxyUrl(proxyUrl)
  if (safeUrl === '[invalid proxy URL]') throw new Error(INVALID_PROXY_ERROR)

  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
    setGlobalDispatcher(new EnvHttpProxyAgent())
  } catch {
    throw new Error(PROXY_SETUP_ERROR)
  }
  log(`出网经代理(跟随 env): ${safeUrl}`)
  return safeUrl
}
