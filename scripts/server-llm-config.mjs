const BASE_URL = 'GUGU_SERVER_LLM_BASE_URL'
const API_KEY = 'GUGU_SERVER_LLM_API_KEY'
const STANDARD_MODEL = 'GUGU_SERVER_LLM_MODEL'
const THINKING_MODEL = 'GUGU_SERVER_LLM_THINKING_MODEL'

function modelVariable(tier) {
  switch (tier) {
    case 'standard':
      return STANDARD_MODEL
    case 'thinking':
      return THINKING_MODEL
    default:
      throw new Error(`Unknown server LLM model tier: ${String(tier)}`)
  }
}

export function readServerLlmConfig(tier, readEnv = (name) => process.env[name]) {
  const modelName = modelVariable(tier)
  const names = [BASE_URL, API_KEY, modelName]
  const values = new Map(names.map((name) => [name, readEnv(name)?.trim() ?? '']))
  const missing = names.filter((name) => !values.get(name))
  if (missing.length > 0) {
    throw new Error(`Missing required server LLM configuration: ${missing.join(', ')}`)
  }

  const baseUrl = values.get(BASE_URL)
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Invalid server LLM configuration: ${BASE_URL} must be an absolute HTTP(S) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid server LLM configuration: ${BASE_URL} must be an absolute HTTP(S) URL`)
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: values.get(API_KEY),
    model: values.get(modelName),
    tier,
  }
}
