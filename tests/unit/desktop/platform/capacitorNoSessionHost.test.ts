// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// @@@phone-web-dir — 手机包不带任务页(scripts/build/phone-web-dir.mts 拷进安卓前去掉任务页入口与它独有的产物),
// 依据就是这一条:手机平台没有 sessionHost,MainLayout 从不挂任务页。这条变了而那一步还在，手机上
// EmdashSessionFrame 去 fetch session-embedded.html 只会拿到 404,构建与其它单测都不会红。
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeFormat: { QrCode: 'QR_CODE' }, BarcodeScanner: {} }))

import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'

describe('capacitor platform has no sessionHost', () => {
  it('stays false — the phone package drops the task page on this fact', () => {
    expect(
      capacitorPlatform.capabilities.sessionHost,
      '手机要任务页了：先删掉 scripts/build/phone-web-dir.mts 这一步(package.json 的 cap:sync / cap:add:android,capacitor.config.ts 的 webDir 改回 dist)'
    ).toBe(false)
  })
})
