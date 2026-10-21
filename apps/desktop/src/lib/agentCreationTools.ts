import { AGENT_TYPES, type SelectableAgentType } from '@gugu/core/shared/enums/agentTypeModels'
import type { AppPlatform } from '../platform/types'

export interface LocalAgentCreationTool {
  id: SelectableAgentType
  label: string
  icon: string
  engine: SelectableAgentType
}

export interface AgentCreationToolDescriptor {
  id: string
  engine: string
  label: string
  icon: string
}

interface LocalToolMeta {
  label: string
  icon: string
  /** Whether the standalone web/mobile ACP surface can create this engine without Electron. */
  acpCreatableWithoutElectron: boolean
}

const LOCAL_TOOL_META: Partial<Record<SelectableAgentType, LocalToolMeta>> = {
  'claude-code': {
    label: 'Claude Code',
    icon: 'assets/tools/claude.svg',
    acpCreatableWithoutElectron: true,
  },
  codex: {
    label: 'Codex',
    icon: 'assets/tools/codex.svg',
    acpCreatableWithoutElectron: true,
  },
  gemini: {
    label: 'Gemini CLI',
    icon: 'assets/tools/gemini.svg',
    // Gemini reachability is only proven through the main-process plugin registry.
    acpCreatableWithoutElectron: false,
  },
  opencode: {
    label: 'OpenCode',
    icon: 'assets/tools/opencode.svg',
    acpCreatableWithoutElectron: true,
  },
  hermes: {
    label: 'Hermes Agent',
    icon: 'assets/tools/hermes.svg',
    acpCreatableWithoutElectron: false,
  },
  openclaw: {
    label: 'OpenClaw',
    icon: 'assets/tools/openclaw.svg',
    acpCreatableWithoutElectron: false,
  },
}

// The registry is the sole provider exposure source. Local tools only retain the
// metadata-backed subset that this fallback surface can create without Electron.
// Web/mobile have no main-process registry. Every AGENT_TYPES entry must still
// declare its fallback decision here; missing metadata fails loudly instead of
// making a newly added engine disappear from the fallback by accident.
const FALLBACK_AGENT_TYPES: readonly SelectableAgentType[] = AGENT_TYPES.filter((engine) => {
  const meta = LOCAL_TOOL_META[engine]
  if (!meta) throw new Error(`Missing local agent creation metadata for '${engine}'`)
  return meta.acpCreatableWithoutElectron
})

export const LOCAL_AGENT_CREATION_TOOLS: LocalAgentCreationTool[] = FALLBACK_AGENT_TYPES
  .map((engine) => {
    const meta = LOCAL_TOOL_META[engine as SelectableAgentType]
    if (!meta) throw new Error(`Missing local agent creation metadata for '${engine}'`)
    return {
      id: engine as SelectableAgentType,
      engine: engine as SelectableAgentType,
      label: meta.label,
      icon: meta.icon,
    }
  })

function iconSource(icon: string): string {
  return icon.trim().startsWith('<svg')
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`
    : icon
}

export function agentCreationToolsFromDescriptors(
  descriptors: readonly AgentCreationToolDescriptor[],
): LocalAgentCreationTool[] {
  return descriptors.map((descriptor) => {
    if (!descriptor || typeof descriptor.engine !== 'string' || !descriptor.engine.trim()) {
      throw new Error('agent creation tools response contains an invalid engine')
    }
    if (typeof descriptor.label !== 'string' || !descriptor.label.trim()) {
      throw new Error(`agent creation tool '${descriptor.engine}' has no label`)
    }
    if (typeof descriptor.icon !== 'string' || !descriptor.icon.trim()) {
      throw new Error(`agent creation tool '${descriptor.engine}' has no icon`)
    }
    return {
      id: descriptor.engine as SelectableAgentType,
      engine: descriptor.engine as SelectableAgentType,
      label: descriptor.label,
      icon: iconSource(descriptor.icon),
    }
  })
}

/**
 * Electron is the only runtime that owns plugin reachability. Web/mobile keep the
 * legacy catalog for their standalone ACP composer, which has no Electron main process.
 */
export async function loadLocalAgentCreationTools(
  runtimePlatform: Pick<AppPlatform, 'kind' | 'getAgentCreationTools'>,
): Promise<LocalAgentCreationTool[]> {
  if (runtimePlatform.kind !== 'electron') return LOCAL_AGENT_CREATION_TOOLS
  if (!runtimePlatform.getAgentCreationTools) {
    throw new Error('Electron agent creation tools bridge is unavailable')
  }
  const raw = await runtimePlatform.getAgentCreationTools()
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Electron returned no reachable agent creation tools')
  }
  return agentCreationToolsFromDescriptors(raw as AgentCreationToolDescriptor[])
}
