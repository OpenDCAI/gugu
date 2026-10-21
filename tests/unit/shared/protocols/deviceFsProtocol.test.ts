import { describe, expect, it } from 'vitest'
import { normalizeDeviceFsListResult } from '@gugu/core/cloud/deviceFsProtocol'

describe('device filesystem protocol', () => {
  it('normalizes list-directory results', () => {
    expect(normalizeDeviceFsListResult({
      path: '/tmp',
      entries: [
        { name: 'a', kind: 'dir' },
        { name: 'b.txt', kind: 'file' },
        { name: 'link', kind: 'symlink' },
        { name: '', kind: 'file' },
        { name: 'secret', kind: 'socket' },
      ],
    })).toEqual({
      path: '/tmp',
      entries: [
        { name: 'a', kind: 'dir' },
        { name: 'b.txt', kind: 'file' },
        { name: 'link', kind: 'symlink' },
      ],
    })
  })

  it('rejects malformed list-directory results', () => {
    expect(normalizeDeviceFsListResult(null)).toBeUndefined()
    expect(normalizeDeviceFsListResult({ entries: [] })).toBeUndefined()
  })
})
