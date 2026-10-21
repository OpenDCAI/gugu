import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import { platform } from '../../platform'
import { rpcOn } from '../../session/renderer/lib/ipc'

export const libraryHost = (machine: AssistantMachine | null | undefined) => platform.capabilities.agentRuntime ? rpcOn(null).app : machine?.rpc.app
