import type { AdmittedChannel, Destination, Have, Life, RunStageEffect, StageOut } from '../../../../packages/core/src/local/session-life/types'

// These guards are compiled with the repository, not executed by a second test harness.
function constructionGuards(channel: AdmittedChannel, all: StageOut): void {
  // @ts-expect-error Only the lifecycle reducer can construct a Life value.
  const externalLife: Life = { kind: 'dormant', hold: null, lastExit: null }
  // @ts-expect-error A channel proof cannot be constructed outside an adapter.
  const externalChannel: AdmittedChannel = { gen: channel.gen }
  // @ts-expect-error Process cannot begin without all five earlier stage outputs.
  const missingPrior: Have<'process'> = { identity: all.identity }
  // @ts-expect-error Channel dispatch requires the preceding process lease too.
  const missingProcess: Have<'channel'> = { identity: all.identity, workspace: all.workspace, capabilities: all.capabilities, platform: all.platform, cli: all.cli }
  // @ts-expect-error Unbound identities cannot be carried into a later stage.
  const unbound: StageOut['identity'] = { kind: 'unbound' }
  // @ts-expect-error A run-stage discriminator must carry that exact stage's accumulated inputs.
  const invalidEffect: RunStageEffect = { e: 'run-stage', gen: channel.gen, at: 'channel', have: {} }
  // @ts-expect-error Archive cannot carry a wake intent.
  const archiveWake: Destination = { kind: 'archived', wakeAfter: true }
  // @ts-expect-error A held destination cannot carry a competing wake intent.
  const heldWake: Destination = { kind: 'held', hold: { reason: 'user-stop', barrier: null }, wakeAfter: true }
  const complete: Have<'channel'> = { identity: all.identity, workspace: all.workspace, capabilities: all.capabilities, platform: all.platform, cli: all.cli, process: all.process }
  void [externalLife, externalChannel, missingPrior, missingProcess, unbound, invalidEffect, archiveWake, heldWake, complete]
}
void constructionGuards
