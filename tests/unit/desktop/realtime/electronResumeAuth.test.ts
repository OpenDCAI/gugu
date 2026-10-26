import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

const fixture = vi.hoisted(() => ({ url: '' }))
vi.mock('electron', () => ({ net: { fetch } }))
vi.mock('@gugu/core/cloud/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js')
  return { createGuguSupabaseClient: (options: { accessToken: () => Promise<string | null> }) =>
    createClient(fixture.url, 'isolated-anon', { accessToken: options.accessToken, realtime: { transport: WebSocket as never } }) }
})
import { bindElectronSupabaseAuth, resumeElectronSupabaseRealtime, supabase } from '../../../../apps/desktop/electron/supabase'
import { _resetElectronRealtimeChannelRegistryForTesting, subscribeAuthenticatedElectronRealtimeChannel } from '../../../../apps/desktop/electron/realtime-channel'

afterEach(async () => {
  _resetElectronRealtimeChannelRegistryForTesting()
  await supabase.removeAllChannels()
  supabase.realtime.disconnect()
  bindElectronSupabaseAuth(async () => null)
})

it('renews the account ticket before rejoining a real isolated private channel after suspension', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as { port: number }
  fixture.url = `http://127.0.0.1:${address.port}`
  let expired = false
  const joins: string[] = [], rejectedJoins: string[] = [], statuses: string[] = [], changes: Array<() => void> = []
  server.on('connection', socket => socket.on('message', bytes => {
    const packet = JSON.parse(String(bytes))
    const [joinRef, ref, topic, event, payload] = Array.isArray(packet)
      ? packet : [packet.join_ref, packet.ref, packet.topic, packet.event, packet.payload]
    if (event !== 'phx_join' && event !== 'heartbeat' && event !== 'phx_leave') return
    const accepted = event !== 'phx_join' || !expired || payload.access_token === 'fresh-ticket'
    if (event === 'phx_join') joins.push(payload.access_token)
    if (event === 'phx_join' && !accepted) rejectedJoins.push(payload.access_token)
    const response = { status: accepted ? 'ok' : 'error', response: accepted ? { postgres_changes: [] } : { reason: 'JWT expired' } }
    socket.send(JSON.stringify(Array.isArray(packet) ? [joinRef, ref, topic, 'phx_reply', response]
      : { join_ref: joinRef, ref, topic, event: 'phx_reply', payload: response }))
  }))
  const provider = vi.fn(async (forceRefresh?: boolean) => forceRefresh ? 'fresh-ticket' : expired ? 'fresh-ticket' : 'retained-ticket')
  // The retained token is still cached by Realtime. Account refresh is owned by
  // the host; a library reconnect must not get to join before that refresh.
  let refreshed = false
  provider.mockImplementation(async forceRefresh => {
    if (forceRefresh) refreshed = true
    return refreshed ? 'fresh-ticket' : 'retained-ticket'
  })
  bindElectronSupabaseAuth(provider)
  const makeChannel = () => supabase.channel(`isolated-${randomUUID()}`, { config: { private: true } })
  const waitFor = async (status: string) => {
    if (statuses.at(-1) === status) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`isolated join: ${statuses.join(',')}; tokens=${joins.join(',')}`)), 1_500)
      const changed = () => { if (statuses.at(-1) === status) { clearTimeout(timer); resolve() } }
      changes.push(changed)
    })
  }
  try {
    await subscribeAuthenticatedElectronRealtimeChannel({ realtime: supabase.realtime,
      removeChannel: channel => supabase.removeChannel(channel as ReturnType<typeof makeChannel>),
    }, makeChannel(), {
      label: 'isolated-resume', createChannel: makeChannel,
      onStatus: status => { statuses.push(status); changes.forEach(change => change()) },
      reconnectOnStatus: () => false,
    })
    await waitFor('SUBSCRIBED')
    expired = true
    statuses.length = 0
    await resumeElectronSupabaseRealtime()
    await waitFor('SUBSCRIBED')
    expect(provider).toHaveBeenCalledWith(true)
    expect(joins).toEqual(['retained-ticket', 'fresh-ticket'])
    // Closing the retained socket itself reports CHANNEL_ERROR. New joins must
    // all carry the renewed ticket, rather than repeatedly being rejected.
    expect(rejectedJoins).toEqual([])
  } finally {
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('does not rebuild channels using the SDK cached ticket when account renewal fails', async () => {
  bindElectronSupabaseAuth(async () => { throw new Error('isolated refresh failed') })
  const disconnect = vi.spyOn(supabase.realtime, 'disconnect')
  try {
    await expect(resumeElectronSupabaseRealtime()).rejects.toThrow('isolated refresh failed')
    expect(disconnect).not.toHaveBeenCalled()
  } finally { disconnect.mockRestore() }
})
