import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { openCuaDaemonLease } from '../../../../apps/desktop/electron/device-actions/native/cua-daemon-lease'

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function daemon(options: { embedded?: boolean; holdReads?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-lease-'))
  const socket = path.join(dir, 's')
  const controls: net.Socket[] = []
  const calls: Array<Record<string, unknown>> = []
  const connections = new Set<net.Socket>()
  const batches = new Map<string, () => void>()
  const server = net.createServer(connection => {
    connections.add(connection)
    connection.once('close', () => connections.delete(connection))
    readline.createInterface({ input: connection }).on('line', line => {
      const request = JSON.parse(line) as Record<string, unknown>
      const send = (result: unknown) => { if (!connection.destroyed) connection.write(`${JSON.stringify({ ok: true, result })}\n`) }
      if (request.method === 'metadata') send({ embedded: options.embedded ?? true, driver_version: '0.36.0', host_bundle_id: 'gugu.test' })
      else if (request.method === 'session_begin') { controls.push(connection); send({ session_begin: true }) }
      else if (request.method === 'call') {
        calls.push(request)
        if (request.name === 'run_steps') {
          const args = request.args as { steps?: Array<{ expect?: unknown }> }
          if (!options.holdReads || !args.steps?.[0]?.expect) batches.set(String(request.session_id), () => send({ content: [], structuredContent: { executed: 9 } }))
        }
        else if (['get_window_state', 'get_agent_cursor_state'].includes(String(request.name)) && options.holdReads) { /* Deliberately leave this observation pending. */ }
        else if (request.name === 'get_agent_cursor_state') send({ content: [], structuredContent: { position: { x: 123, y: 456 } } })
        else connection.write(`${JSON.stringify({ ok: false, error: 'session has ended', exit_code: 1 })}\n`)
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  cleanups.push(async () => {
    for (const connection of connections) connection.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { socket, controls, calls, finishBatch: (owner?: string) => (owner ? batches.get(owner) : batches.values().next().value)?.() }
}

describe('cua daemon owner lease', () => {
  it('samples the same owner while its batch is blocked; preview never queues behind the batch', async () => {
    const host = await daemon()
    let ended = 0
    const lease = await openCuaDaemonLease({ socket: host.socket, owner: 'owner-a', hostBundleId: 'gugu.test', timeoutMs: 1000, onClosed: () => { ended++ } })
    cleanups.push(() => lease.close())
    let finished = false
    const batch = lease.call('run_steps', { session: 'agent-a' }).then(value => { finished = true; return value })
    const cursor = await lease.call('get_agent_cursor_state', { session: 'agent-a', _transport_session_id: 'forged' })
    expect(cursor.structuredContent?.position).toEqual({ x: 123, y: 456 })
    expect(finished).toBe(false)
    expect(host.calls.every(call => call.session_id === 'owner-a')).toBe(true)
    expect(host.calls[1]?.args).toEqual({ session: 'agent-a' })
    host.finishBatch()
    expect((await batch).structuredContent?.executed).toBe(9)
    host.controls[0]!.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ended).toBe(1)
    await expect(lease.call('get_agent_cursor_state', {})).rejects.toThrow('连接已结束')
  })

  it('keeps a native refusal distinct from transport failure', async () => {
    const host = await daemon()
    const lease = await openCuaDaemonLease({ socket: host.socket, owner: 'owner-b', timeoutMs: 1000, onClosed: () => undefined })
    cleanups.push(() => lease.close())
    expect(await lease.call('click', {})).toMatchObject({ isError: true, content: [{ type: 'text', text: 'session has ended' }] })
    expect((await lease.call('get_agent_cursor_state', {})).structuredContent?.position).toEqual({ x: 123, y: 456 })
    expect(host.controls[0]!.destroyed).toBe(false)
  })

  it.each(['timeout', 'abort'] as const)('an input %s closes only its owner control, once', async mode => {
    const host = await daemon()
    let ended = 0
    const lease = await openCuaDaemonLease({ socket: host.socket, owner: 'input-owner', timeoutMs: 1000, onClosed: () => { ended++ } })
    const other = await openCuaDaemonLease({ socket: host.socket, owner: 'other-owner', timeoutMs: 1000, onClosed: () => undefined })
    cleanups.push(() => lease.close(), () => other.close())
    const otherBatch = other.call('run_steps', { steps: [{ click: {} }] }).catch((error: unknown) => error)
    const stop = new AbortController()
    const batch = lease.call('run_steps', { steps: [{ click: { pid: 1, window_id: 2 } }] }, { timeoutMs: mode === 'timeout' ? 40 : 1000, signal: stop.signal })
    const rejected = batch.catch((error: unknown) => error)
    await expect.poll(() => host.calls.some(call => call.name === 'run_steps' && call.session_id === 'input-owner')).toBe(true)
    if (mode === 'abort') stop.abort()
    expect(await rejected).toMatchObject({ message: expect.stringMatching(/可能部分执行.*结果未确认/) })
    await expect.poll(() => host.controls[0]!.destroyed).toBe(true)
    expect(ended).toBe(1)
    lease.close()
    expect(ended).toBe(1)
    expect(host.controls[1]!.destroyed).toBe(false)
    expect((await other.call('get_agent_cursor_state', {})).structuredContent?.position).toEqual({ x: 123, y: 456 })
    host.finishBatch('other-owner')
    expect(await otherBatch).toMatchObject({ structuredContent: { executed: 9 } })
  })

  it.each([
    ['timeout', 'get_window_state'], ['abort', 'get_window_state'],
    ['timeout', 'get_agent_cursor_state'], ['abort', 'get_agent_cursor_state'],
    ['timeout', 'run_steps'], ['abort', 'run_steps'],
  ] as const)('an observation %s (%s) preserves the same owner input in flight', async (mode, name) => {
    const host = await daemon({ holdReads: true })
    let ended = 0
    const lease = await openCuaDaemonLease({ socket: host.socket, owner: 'shared-owner', timeoutMs: 1000, onClosed: () => { ended++ } })
    cleanups.push(() => lease.close())
    const batch = lease.call('run_steps', { steps: [{ click: {} }] })
    const stop = new AbortController()
    const read = lease.call(name, name === 'run_steps' ? { steps: [{ expect: [{ text: '0' }] }] } : {}, { timeoutMs: mode === 'timeout' ? 40 : 1000, signal: stop.signal })
    const rejected = expect(read).rejects.toThrow()
    await expect.poll(() => host.calls.filter(call => call.name === name).length >= (name === 'run_steps' ? 2 : 1)).toBe(true)
    if (mode === 'abort') stop.abort()
    await rejected
    expect(ended).toBe(0)
    expect(host.controls[0]!.destroyed).toBe(false)
    host.finishBatch('shared-owner')
    expect((await batch).structuredContent?.executed).toBe(9)
  })

  it('an already-aborted input is not sent and does not retire an active input owner', async () => {
    const host = await daemon()
    let ended = 0
    const lease = await openCuaDaemonLease({ socket: host.socket, owner: 'owner', timeoutMs: 1000, onClosed: () => { ended++ } })
    cleanups.push(() => lease.close())
    const batch = lease.call('run_steps', { steps: [{ click: {} }] })
    const stop = new AbortController()
    stop.abort()
    await expect(lease.call('click', {}, { signal: stop.signal })).rejects.toThrow('已取消')
    expect(ended).toBe(0)
    expect(host.calls.some(call => call.name === 'click')).toBe(false)
    await expect.poll(() => host.calls.some(call => call.name === 'run_steps')).toBe(true)
    host.finishBatch('owner')
    expect((await batch).structuredContent?.executed).toBe(9)
  })

  it('refuses a socket owned by a non-embedded daemon before starting a session', async () => {
    const host = await daemon({ embedded: false })
    await expect(openCuaDaemonLease({ socket: host.socket, owner: 'owner-c', timeoutMs: 1000, onClosed: () => undefined })).rejects.toThrow('宿主身份不匹配')
    expect(host.controls).toEqual([])
  })
})
