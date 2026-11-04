import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// A project chat has no file host: each version is kept by the device that sent it. No client code may read a chat's
// file host, hand bytes to one, or translate a host-only refusal — those all went with the host.
const repo = join(__dirname, '../../..')
const roots = ['apps/desktop/src', 'apps/desktop/electron', 'apps/desktop/preinstalled-apps', 'packages/core/src']
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name)
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
  return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : []
})

it('no client source knows a chat file host', () => {
  const found = roots.flatMap((root) => sources(join(repo, root)))
    .filter((path) => /file_project_policy_|file-handoff-|file_version_handoff|kept-on-host|Only the bound (file )?host/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(repo, path))
  expect(found).toEqual([])
})
