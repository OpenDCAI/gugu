import { describe, expect, it } from 'vitest'
import { serverChannelForBackend } from '../../../../apps/desktop/electron/server/server-channel'

const PROD = 'db.example.test'

describe('给别的机器装哪条通道的 server(#6264):跟这台桌面实际连的库走', () => {
  it('连生产库 ⇒ 正式通道', () => {
    expect(serverChannelForBackend(`https://${PROD}`, PROD)).toBe('stable')
    expect(serverChannelForBackend(`https://${PROD}/`, PROD)).toBe('stable')
  })

  it('连别的库(共享测试库、本地库)⇒ Beta,开发构建的 tier 是 production 也一样', () => {
    expect(serverChannelForBackend('https://devdb.example.test', PROD)).toBe('beta')
    expect(serverChannelForBackend('http://127.0.0.1:54321', PROD)).toBe('beta')
  })

  it('只认整个 host:生产库的子域、带端口、拿不到地址都不算生产库', () => {
    expect(serverChannelForBackend(`https://dev${PROD}`, PROD)).toBe('beta')
    expect(serverChannelForBackend(`https://${PROD}:8443`, PROD)).toBe('beta')
    expect(serverChannelForBackend('not a url', PROD)).toBe('beta')
    expect(serverChannelForBackend(null, PROD)).toBe('beta')
  })
})
