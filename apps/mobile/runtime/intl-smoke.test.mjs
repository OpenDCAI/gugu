import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPhoneIntl } from './intl-smoke.mjs'

test('keeps phone date, number, collation and dictionary segmentation in three locales', () => {
  assert.deepEqual(checkPhoneIntl().map((row) => row.locale), ['en-US', 'zh-CN', 'ja-JP'])
})
