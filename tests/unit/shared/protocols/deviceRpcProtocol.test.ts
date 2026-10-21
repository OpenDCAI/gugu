import { describe, expect, it } from 'vitest'
import {
  createDeviceRpcRequestEnvelope,
  deviceRpcAskerChannelName,
  deviceRpcChannelName,
  deviceRpcFrameType,
  deviceRpcReplyType,
  isSubscribeFailure,
  parseDeviceRpcReply,
  subscribeStatusName,
} from '@gugu/core/cloud/deviceRpcProtocol'

describe('device RPC protocol', () => {
  it('builds stable channel names and request envelopes', () => {
    expect(deviceRpcChannelName('dev-1')).toBe('gugu:dev-1:rpc')
    expect(deviceRpcReplyType('fs.list-directory')).toBe('fs.list-directory:reply')
    expect(createDeviceRpcRequestEnvelope('fs.list-directory', 'req-1', 'user-1', { path: '~' })).toEqual({
      type: 'fs.list-directory',
      request_id: 'req-1',
      user_id: 'user-1',
      payload: { path: '~' },
    })
  })

  it('parses direct and Supabase-wrapped replies', () => {
    expect(parseDeviceRpcReply({
      type: 'fs.list-directory:reply',
      request_id: 'req-1',
      result: { ok: true },
    })).toEqual({
      type: 'fs.list-directory:reply',
      requestId: 'req-1',
      result: { ok: true },
      error: undefined,
    })

    expect(parseDeviceRpcReply({
      event: 'broadcast',
      type: 'broadcast',
      payload: {
        type: 'fs.list-directory:reply',
        request_id: 'req-2',
        error: { code: 'denied', message: 'No' },
      },
    })).toEqual({
      type: 'fs.list-directory:reply',
      requestId: 'req-2',
      result: undefined,
      error: { code: 'denied', message: 'No' },
    })
  })

  it('normalizes subscribe statuses', () => {
    expect(subscribeStatusName({ value: 'SUBSCRIBED' })).toBe('SUBSCRIBED')
    expect(isSubscribeFailure('TIMED_OUT')).toBe(true)
    expect(isSubscribeFailure({ value: 'REALTIME_CHANNEL.SUBSCRIBED' })).toBe(false)
  })

  // #7233 一个发问端一条线:第四段是发问端;RLS 只看前三段(gugu / 设备 / rpc),所以这一段不能带 `:`。
  it('names each asker topic under the device topic, and refuses an asker id that would split it', () => {
    expect(deviceRpcAskerChannelName('dev-1', 'askerAAAA1111')).toBe('gugu:dev-1:rpc:askerAAAA1111')
    expect(() => deviceRpcAskerChannelName('dev-1', 'a:b:cdefgh')).toThrow(/invalid device RPC asker id/)
    expect(() => deviceRpcAskerChannelName('dev-1', 'short')).toThrow()
  })

  it('reads the type of a host frame, wrapped or not', () => {
    expect(deviceRpcFrameType({ type: 'broadcast', event: 'broadcast', payload: { type: 'taskhost.alive' } })).toBe('taskhost.alive')
    expect(deviceRpcFrameType({ type: 'taskhost.detached', reason: 'idle' })).toBe('taskhost.detached')
    expect(deviceRpcFrameType(null)).toBeNull()
  })
})
