import type { AgentRuntimeKind } from './agentRuntimeSession'

export type AgentProviderSessionEnvVar = 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID'

export interface AgentProviderSessionDetection {
  runtime: AgentRuntimeKind
  providerSessionId: string
  envVar: AgentProviderSessionEnvVar
}

// #1229 — gemini 无对应 provider-session env var（claude/codex 各有自家 CLI 注入的 session/thread
// id env；gemini-cli 的 ACP session resume 语义未确认，不臆造一个 env var）。故用 Partial：gemini
// 走「无 provider-session 检测」路径（每次新会话，不恢复），后续若 gemini-cli 暴露 session id 再补。
const agentProviderSessionEnvVars: Partial<Record<AgentRuntimeKind, AgentProviderSessionEnvVar>> = {
  'claude-code': 'CLAUDE_CODE_SESSION_ID',
  codex: 'CODEX_THREAD_ID'
}

const agentProviderSessionPrecedence = ['claude-code', 'codex'] as const satisfies readonly AgentRuntimeKind[]

export function agentProviderSessionEnvVar(
  runtime: AgentRuntimeKind
): AgentProviderSessionEnvVar | undefined {
  return agentProviderSessionEnvVars[runtime]
}

export function getCurrentAgentProviderSessionId(
  runtime: AgentRuntimeKind,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const envVar = agentProviderSessionEnvVar(runtime)
  if (!envVar) return undefined // gemini 等无 provider-session env var → 无可恢复会话
  const value = env[envVar]?.trim()
  return value || undefined
}

export function detectAgentProviderSession(
  env: NodeJS.ProcessEnv = process.env
): AgentProviderSessionDetection | null {
  for (const runtime of agentProviderSessionPrecedence) {
    const envVar = agentProviderSessionEnvVar(runtime)
    if (!envVar) continue // precedence 只含有 env var 的 runtime（claude/codex）；防御性跳过
    const providerSessionId = getCurrentAgentProviderSessionId(runtime, env)
    if (providerSessionId) {
      return { runtime, providerSessionId, envVar }
    }
  }
  return null
}
