import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuickChatShortcutOwner, quickChatOwnerPort, type QuickChatShortcutOwner } from '../../../../apps/desktop/electron/quick-chat-shortcut-owner'
import { awaitFact, awaitPending } from '../../../support/awaitFact'

const owners: QuickChatShortcutOwner[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose() })
async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}
function candidate(port: number) {
  const onChange = vi.fn()
  const onError = vi.fn()
  const owner = createQuickChatShortcutOwner({ port, onChange, onError })
  owners.push(owner)
  return { owner, onChange, onError }
}
const acquired = (owner: QuickChatShortcutOwner) => awaitFact('exclusive shortcut owner acquired', () => owner.owns() ? true : undefined)

describe('Quick Chat cross-profile shortcut owner', () => {
  it('uses one stable endpoint for the same OS user and accelerator', () => {
    expect(quickChatOwnerPort('Alt+Shift+Space')).toBe(quickChatOwnerPort('Alt+Shift+Space'))
    expect(quickChatOwnerPort('Alt+Shift+Space')).toBeGreaterThanOrEqual(49152)
    expect(quickChatOwnerPort('Alt+Shift+Space')).toBeLessThanOrEqual(65535)
  })

  it('elects exactly one concurrent owner, then transfers on disable and dispose', async () => {
    const port = await freePort()
    const candidates = Array.from({ length: 3 }, () => candidate(port))
    for (const { owner } of candidates) owner.setEnabled(true)
    const winner = await awaitFact('one contender owns the shortcut', () => candidates.find(({ owner }) => owner.owns()))
    expect(candidates.filter(({ owner }) => owner.owns())).toHaveLength(1)
    winner.owner.setEnabled(false)
    const second = await awaitFact('disabled owner hands off', () => candidates.find((item) => item !== winner && item.owner.owns()))
    expect(candidates.filter(({ owner }) => owner.owns())).toHaveLength(1)
    second.owner.dispose()
    await awaitFact('disposed owner hands off', () => candidates.find((item) => item !== winner && item !== second && item.owner.owns()))
    expect(candidates.filter(({ owner }) => owner.owns())).toHaveLength(1)
    for (const { onError } of candidates) expect(onError).not.toHaveBeenCalled()
  })

  it('hands the shortcut to the newly foreground instance even when B already has an auxiliary window', async () => {
    const port = await freePort()
    const b = candidate(port)
    b.owner.setForeground(true)
    b.owner.setEnabled(true)
    await acquired(b.owner)
    b.owner.setForeground(false)
    // A is a normal eligible follower. B remains alive with its ready aux.
    const a = candidate(port)
    a.owner.setForeground(true)
    a.owner.setEnabled(true)
    await acquired(a.owner)
    expect(b.owner.owns()).toBe(false)
    expect(b.onChange.mock.calls.map(([value]) => value)).toEqual([true, false])
    a.owner.setForeground(false)
    b.owner.setForeground(true)
    await acquired(b.owner)
    expect(a.owner.owns()).toBe(false)
    expect(a.onError).not.toHaveBeenCalled()
    expect(b.onError).not.toHaveBeenCalled()
  })

  it('keeps global availability outside Gugu and never registers two owners during a focus handoff', async () => {
    const port = await freePort()
    const active = new Set<string>()
    const overlaps: string[][] = []
    const make = (name: string) => {
      const owner = createQuickChatShortcutOwner({ port, onError: (error) => { throw error }, onChange(owned) {
        if (owned) active.add(name); else active.delete(name)
        if (active.size > 1) overlaps.push([...active])
      } })
      owners.push(owner)
      return owner
    }
    const a = make('A')
    const b = make('B')
    b.setForeground(true)
    b.setEnabled(true)
    await acquired(b)
    b.setForeground(false)
    expect(b.owns()).toBe(true)
    a.setEnabled(true)
    a.setForeground(true)
    await acquired(a)
    expect(b.owns()).toBe(false)
    a.setForeground(false)
    expect(a.owns()).toBe(true)
    b.setForeground(true)
    await acquired(b)
    expect(overlaps).toEqual([])
  })

  it('does not write foreground changes to the completed handoff connection', async () => {
    const port = await freePort()
    const b = candidate(port)
    b.owner.setEnabled(true)
    await acquired(b.owner)
    const a = candidate(port)
    a.onChange.mockImplementation((owned: boolean) => {
      // Runs after listener acquisition ends the grant socket, before its close
      // callback: an actual focus event can arrive in this same interval.
      if (owned) queueMicrotask(() => a.owner.setForeground(false))
    })
    a.owner.setForeground(true)
    a.owner.setEnabled(true)
    await acquired(a.owner)
    expect(a.onError).not.toHaveBeenCalled()
    expect(b.owner.owns()).toBe(false)
  })

  it('does not resurrect a disabled contender after a pending listen or connect', async () => {
    const port = await freePort()
    const a = candidate(port)
    const b = candidate(port)
    a.owner.setEnabled(true)
    await acquired(a.owner)
    b.owner.setEnabled(true)
    b.owner.setEnabled(false)
    a.owner.dispose()
    const replacement = candidate(port)
    replacement.owner.setEnabled(true)
    await acquired(replacement.owner)
    expect(b.owner.owns()).toBe(false)
    expect(b.onChange).not.toHaveBeenCalledWith(true)
  })

  it('fails closed on a foreign listener without retrying against it', async () => {
    let connections = 0
    const foreign = createServer((socket) => { ++connections; socket.end('another-service\n') })
    foreign.listen(0, '127.0.0.1')
    await once(foreign, 'listening')
    const a = candidate((foreign.address() as AddressInfo).port)
    try {
      a.owner.setEnabled(true)
      await awaitFact('foreign endpoint rejected', () => a.onError.mock.calls.length ? true : undefined)
      expect(a.owner.owns()).toBe(false)
      a.owner.dispose()
      expect(connections).toBe(1)
    } finally { await new Promise<void>((resolve) => foreign.close(() => resolve())) }
  })

  it('releases kernel ownership on process death so a different process can register', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gugu-shortcut-owner-'))
    const entry = join(directory, 'owner.mjs')
    const port = await freePort()
    const output = buildSync({
      stdin: { contents: `
        import { createQuickChatShortcutOwner } from './apps/desktop/electron/quick-chat-shortcut-owner'
        const owner = createQuickChatShortcutOwner({ port: ${port},
          onChange: owned => process.send({owned}), onError: error => process.send({error: error.message}) })
        process.on('message', message => { if (message === 'enable') owner.setEnabled(true) })
        process.send({ready: true})
      `, resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', write: false,
    })
    writeFileSync(entry, output.outputFiles[0]!.text)
    const children: ChildProcess[] = []
    const launch = () => {
      const messages: Array<{ owned?: boolean; ready?: boolean; error?: string }> = []
      const child = fork(entry, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      children.push(child)
      child.on('message', (message) => messages.push(message as typeof messages[number]))
      return { child, messages }
    }
    try {
      const a = launch()
      const b = launch()
      await awaitFact('both isolated processes ready', () => a.messages.some((m) => m.ready) && b.messages.some((m) => m.ready) ? true : undefined)
      a.child.send('enable')
      await awaitFact('process A owns native registration permission', () => a.messages.some((m) => m.owned) ? true : undefined, { producer: a.child })
      b.child.send('enable')
      // Exact child handle, not a broad process match. The kernel closes its listener.
      const exited = once(a.child, 'exit')
      a.child.kill('SIGKILL')
      await awaitPending('process A exited', exited)
      await awaitFact('process B takes released ownership', () => b.messages.some((m) => m.owned) ? true : undefined, { producer: b.child })
      expect(a.messages.filter((m) => m.error)).toEqual([])
      expect(b.messages.filter((m) => m.error)).toEqual([])
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
