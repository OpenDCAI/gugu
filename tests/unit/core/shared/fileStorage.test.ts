import { describe, expect, it } from 'vitest'
import { DEFAULT_FILE_STORAGE, parseFileStorage } from '../../../../packages/core/src/shared/fileStorage'

describe('the account file storage setting', () => {
  it('reads an unset setting as the defaults the server applies', () => {
    expect(parseFileStorage({})).toEqual({ proactive_upload: false, temporary_transfer: true, retention: '7d', image_retention: '7d', temporary_retention: '7d' })
    expect(parseFileStorage({ other: 1 })).toBe(DEFAULT_FILE_STORAGE)
  })
  it('fills missing keys and keeps the values set', () => {
    expect(parseFileStorage({ file_storage: { image_retention: '30d', retention: 'read-once' } }))
      .toEqual({ ...DEFAULT_FILE_STORAGE, image_retention: '30d', retention: 'read-once' })
  })
  it('reads a setting a newer client wrote: keys it does not know are left alone, not a malformed setting', () => {
    expect(parseFileStorage({ file_storage: { image_retention: '30d', temporary_retention: '1d', later_key: { any: 1 } } }))
      .toEqual({ ...DEFAULT_FILE_STORAGE, image_retention: '30d', temporary_retention: '1d' })
  })
  it('refuses what the server would refuse instead of falling back to defaults', () => {
    for (const file_storage of [null, [], 'x', { image_retention: 'read-once' }, { retention: 'forever' }, { proactive_upload: 'yes' }, { temporary_retention: 'read-once' }]) {
      expect(() => parseFileStorage({ file_storage })).toThrow('user_settings.file_storage is malformed')
    }
  })
})
