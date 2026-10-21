export function readProxyEnv(env?: NodeJS.ProcessEnv): string | undefined
export function redactProxyUrl(raw: unknown): string
export function configureEnvHttpProxy(
  env?: NodeJS.ProcessEnv,
  log?: (message: string) => void
): Promise<string | undefined>
