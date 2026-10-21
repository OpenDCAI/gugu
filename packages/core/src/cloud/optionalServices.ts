// These switches describe configured providers, not paid entitlements. The server remains
// authoritative for access to official resources. Existing official builds keep their behavior;
// a community installation explicitly disables the providers it does not deploy.
declare const __GUGU_CLOUD_COMPUTER_ENABLED__: string | undefined
declare const __GUGU_PLATFORM_MODELS_ENABLED__: string | undefined

export function parseOptionalServiceEnabled(value: string | undefined, key: string): boolean {
  const flag = value?.trim().toLowerCase()
  if (!flag || flag === 'true') return true
  if (flag === 'false') return false
  throw new Error(key + ' must be true or false')
}

function enabled(key: string, baked: string | undefined): boolean {
  const viteKey = 'VITE_' + key
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const node = typeof process === 'undefined' ? undefined : process.env[key]
  return parseOptionalServiceEnabled(meta?.[viteKey] || node || baked, key)
}

export function cloudComputerEnabled(): boolean {
  const baked = typeof __GUGU_CLOUD_COMPUTER_ENABLED__ === 'undefined' ? undefined : __GUGU_CLOUD_COMPUTER_ENABLED__
  return enabled('GUGU_CLOUD_COMPUTER_ENABLED', baked)
}

export function platformModelsEnabled(): boolean {
  const baked = typeof __GUGU_PLATFORM_MODELS_ENABLED__ === 'undefined' ? undefined : __GUGU_PLATFORM_MODELS_ENABLED__
  return enabled('GUGU_PLATFORM_MODELS_ENABLED', baked)
}

/** Whether this installation has configured any official service that uses account billing. */
export function officialServicesEnabled(): boolean {
  return cloudComputerEnabled() || platformModelsEnabled()
}
