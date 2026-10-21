export type ServerLlmModelTier = 'standard' | 'thinking'

export interface ServerLlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  tier: ServerLlmModelTier
}

export function readServerLlmConfig(
  tier: ServerLlmModelTier,
  readEnv?: (name: string) => string | undefined,
): ServerLlmConfig
