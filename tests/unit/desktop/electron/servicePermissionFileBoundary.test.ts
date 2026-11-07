import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { uploadSessionFile } from '@gugu/core/local/agent/sessionFileHandoff'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { readUploadBytes } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('refuses a real hard-linked journal in the chat attachment byte gateway', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gugu-permission-hard-upload-'))
  roots.push(home)
  vi.stubEnv('GUGU_HOME', home)
  const directory = join(home, 'private-service-permissions', 'owner')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'journal.jsonl')
  const alias = join(home, 'ordinary.txt')
  await writeFile(file, 'private-hard-link-canary')
  await link(file, alias)
  await expect(readUploadBytes('message_send_file', { file_path: alias }, 1024)).rejects.toThrow('protected private storage')
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('must not upload'))
  await expect(uploadSessionFile({ supabaseUrl: 'https://example.invalid', anonKey: '', token: '', fetch }, { file_path: alias },
    { agentId: 'agent', sessionId: 'session', recipients: [] })).rejects.toThrow('protected private storage')
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses private state through chat upload bytes and session attachments, including symlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gugu-permission-upload-'))
  roots.push(home)
  vi.stubEnv('GUGU_HOME', home)
  const directory = join(home, 'private-service-permissions', 'owner')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'journal.jsonl')
  await writeFile(file, 'private-session-canary')
  const alias = join(home, 'alias.jsonl')
  await symlink(file, alias)
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('must not upload'))
  for (const file_path of [file, alias]) {
    await expect(readUploadBytes('message_send_file', { file_path }, 1024)).rejects.toThrow('protected private storage')
    await expect(uploadSessionFile({ supabaseUrl: 'https://example.invalid', anonKey: '', token: '', fetch }, { file_path },
      { agentId: 'agent', sessionId: 'session', recipients: [] })).rejects.toThrow('protected private storage')
  }
  expect(fetch).not.toHaveBeenCalled()
})
