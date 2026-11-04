import { signalProcessDescendantsSync } from '@gugu/session-core/acp/node'

/** Available before account startup too: snapshot before the host severs any parent chain. */
export function killServerDescendantsSync(workerPids: readonly number[] = []): void {
  signalProcessDescendantsSync([process.pid, ...workerPids], 'SIGKILL')
}
