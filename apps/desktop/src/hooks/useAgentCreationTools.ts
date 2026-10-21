import { useEffect, useState } from 'react'
import {
  loadLocalAgentCreationTools,
  LOCAL_AGENT_CREATION_TOOLS,
  type LocalAgentCreationTool,
} from '../lib/agentCreationTools'
import { platform } from '../platform'

/**
 * Load the renderer-facing provider projection once. Electron gets the
 * main-process reachability result; web/mobile use the ACP-only fallback.
 */
export function useAgentCreationTools(): {
  tools: readonly LocalAgentCreationTool[]
  error: string | null
} {
  const [tools, setTools] = useState<readonly LocalAgentCreationTool[]>(() =>
    platform.kind === 'electron' ? [] : LOCAL_AGENT_CREATION_TOOLS,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void loadLocalAgentCreationTools(platform)
      .then((next) => {
        if (!active) return
        setTools(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      active = false
    }
  }, [])

  return { tools, error }
}
