import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
const { createAssistantPanelBodyFailures } = await import('../../apps/desktop/electron/sessionpage/assistant-panel-body-failures')

const roots: string[] = []
beforeEach(() => { warn.mockReset() })
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
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
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

/** Where the journal for this owner and assistant lives (the file name is a hash, never the ids themselves). */
function journalPath(root: string,owner = 'owner',assistant = 'assistant'): string {
  const id = createHash('sha256').update(JSON.stringify([owner,assistant])).digest('hex')
  return join(root,'assistant-panel-body-failures',`${id}.json`)
}

// The journal is disposable: a file it cannot use is an empty journal, said once in the log with why — never a stop to
// publication, never the file's content in the log — and the next successful save replaces it whole.
it.each([
  ['corrupt', '{"version":1,"owner":"owner","assistant":"assistant","failures":[[', 'SyntaxError'],
  ['unsupported', JSON.stringify({ version: 2,owner: 'owner',assistant: 'assistant',failures: [] }), 'PANEL_BODY_FAILURE_STATE_INVALID'],
  ['written for another assistant', JSON.stringify({ version: 1,owner: 'owner',assistant: 'other',failures: [] }), 'PANEL_BODY_FAILURE_STATE_INVALID'],
])('treats a %s journal as empty, warns once with what kind of failure, and a later save replaces it', async (_case,content,kind) => {
  const root = await mkdtemp(join(tmpdir(),'panel-body-failures-')); roots.push(root)
  const path = journalPath(root)
  await mkdir(join(root,'assistant-panel-body-failures'),{ recursive: true })
  await writeFile(path,content)
  const journal = createAssistantPanelBodyFailures(root,'owner','assistant')

  expect(await journal.get('memory','note')).toBeUndefined()
  await journal.set('memory','note',failure)
  expect(await journal.get('memory','note')).toEqual(failure)

  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith({ operation: 'read',kind },expect.any(String))
  expect(JSON.stringify(warn.mock.calls)).not.toContain('failures')
  expect(await createAssistantPanelBodyFailures(root,'owner','assistant').get('memory','note')).toEqual(failure)
})

it('keeps suppressing in memory when the journal can be neither read nor written, with a single warning', async () => {
  const root = await mkdtemp(join(tmpdir(),'panel-body-failures-')); roots.push(root)
  await mkdir(journalPath(root),{ recursive: true })
  const journal = createAssistantPanelBodyFailures(root,'owner','assistant')

  expect(await journal.get('memory','note')).toBeUndefined()
  await journal.set('memory','note',failure)
  await journal.set('memory','other-note',failure)
  expect(await journal.get('memory','note')).toEqual(failure)
  expect(await journal.get('memory','other-note')).toEqual(failure)

  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn).toHaveBeenCalledWith({ operation: 'read',kind: 'EISDIR' },expect.any(String))
})
