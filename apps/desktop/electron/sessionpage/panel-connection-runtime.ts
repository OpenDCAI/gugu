import { createAssistantPanelRuntime } from './assistant-panel-runtime'
import { createConnectionRuntime } from './connection-runtime'

/** Shared shell lifetime; connection work itself has no assistant binding. */
export function createPanelConnectionRuntime(input: Parameters<typeof createAssistantPanelRuntime>[0]) {
  const connections = createConnectionRuntime({ ...input,failed: () => input.failed('owner-connections') })
  const panel = createAssistantPanelRuntime({ ...input,connectionAuthority: connections.authority })
  input.local.setOwnerConnectionControl(connections)
  return { ...panel,connections,
    // The approved activation step will install the owner task barrier. Until
    // then ordinary task admission retains its existing path.
    prepare: panel.prepare,
    dispose() { connections.dispose(); panel.dispose() },
  }
}
