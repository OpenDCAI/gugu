import { createAssistantPanelRuntime } from './assistant-panel-runtime'
import { createConnectionRuntime } from './connection-runtime'

/** Shared shell lifetime; connection work itself has no assistant binding. */
export function createPanelConnectionRuntime(input: Parameters<typeof createAssistantPanelRuntime>[0]) {
  const panel = createAssistantPanelRuntime(input)
  const connections = createConnectionRuntime({ ...input,failed: () => input.failed('owner-connections') })
  input.local.setOwnerConnectionControl(connections)
  return { ...panel,connections,
    async prepare(sessionId: string,text: string) { await connections.prepare(); return panel.prepare(sessionId,text) },
    dispose() { connections.dispose(); panel.dispose() },
  }
}
