import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,it,expect } from 'vitest'
import { createConnectionObservationHolds } from '../../apps/desktop/electron/sessionpage/connection-observation-holds'
let root: string
afterEach(async () => { if (root) await rm(root,{ recursive: true,force: true }) })
it('preserves an interrupted provider across restart and rejects a late release from an older intent', async () => {
  root = await mkdtemp(join(tmpdir(),'connection-observation-'))
  const store = (ownerId = 'owner') => createConnectionObservationHolds({ guguHome: root,ownerId,deviceId: 'device',assertCurrent: async () => {} })
  const old = '6c67af58-7190-4c6f-9d49-06d0f6f4865f',current = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
  await store().begin('github',old)
  const resumed = store()
  expect(await resumed.load()).toEqual({ github: old })
  await resumed.begin('github',current)
  await resumed.release('github',old)
  expect(await store().load()).toEqual({ github: current })
  expect(await store('other').load()).toEqual({})
  await resumed.release('github',current)
  expect(await store().load()).toEqual({})
})
