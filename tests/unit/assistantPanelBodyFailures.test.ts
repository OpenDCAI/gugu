import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createAssistantPanelBodyFailures } from '../../apps/desktop/electron/sessionpage/assistant-panel-body-failures'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true }))) })
const failure = { sha256: 'a'.repeat(64),code: 'invalid-body' as const }

it('persists parallel domain updates without losing failures and prunes only the absent domain keys', async () => {
  const root = await mkdtemp(join(tmpdir(),'panel-body-failures-')); roots.push(root)
  const journal = createAssistantPanelBodyFailures(root,'owner','assistant')
  await Promise.all([journal.set('memory','note',failure),journal.set('integrations','account',failure)])
  const reopened = createAssistantPanelBodyFailures(root,'owner','assistant')
  expect(await reopened.get('memory','note')).toEqual(failure)
  expect(await reopened.get('integrations','account')).toEqual(failure)
  await reopened.retain('memory',new Set())
  const next = createAssistantPanelBodyFailures(root,'owner','assistant')
  expect(await next.get('memory','note')).toBeUndefined()
  expect(await next.get('integrations','account')).toEqual(failure)
  const folder = join(root,'assistant-panel-body-failures'), files = await readdir(folder)
  expect(files).toHaveLength(1)
  const path = join(folder,files[0])
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(path,'utf8')).failures).toHaveLength(1)
})

it('keeps failure suppression scoped to the owner, assistant, domain and resource', async () => {
  const root = await mkdtemp(join(tmpdir(),'panel-body-failures-')); roots.push(root)
  await createAssistantPanelBodyFailures(root,'owner','assistant').set('memory','note',failure)
  expect(await createAssistantPanelBodyFailures(root,'other-owner','assistant').get('memory','note')).toBeUndefined()
  expect(await createAssistantPanelBodyFailures(root,'owner','other-assistant').get('memory','note')).toBeUndefined()
  const reopened = createAssistantPanelBodyFailures(root,'owner','assistant')
  expect(await reopened.get('files','note')).toBeUndefined()
  expect(await reopened.get('memory','other-note')).toBeUndefined()
})
