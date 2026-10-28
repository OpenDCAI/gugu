import { describe, expect, it } from 'vitest'
import { PRODUCTION_DB_HOST, serverChannelForDb } from '../../../scripts/build-env-preflight.mjs'

describe('给别的机器装哪条通道的 server(#6264):跟这次构建连的库走', () => {
  it('连生产库 ⇒ 正式通道', () => {
    expect(serverChannelForDb(`https://${PRODUCTION_DB_HOST}`)).toBe('stable')
    expect(serverChannelForDb(`https://${PRODUCTION_DB_HOST}/`)).toBe('stable')
  })

  it('连别的库(共享测试库、本地库)⇒ Beta,开发构建的 tier 是 production 也一样', () => {
    expect(serverChannelForDb('https://devdb.example.test')).toBe('beta')
    expect(serverChannelForDb('http://127.0.0.1:54321')).toBe('beta')
  })

  it('只认整个 host:生产库的子域、带端口、拿不到地址都不算生产库', () => {
    expect(serverChannelForDb(`https://dev${PRODUCTION_DB_HOST}`)).toBe('beta')
    expect(serverChannelForDb(`https://${PRODUCTION_DB_HOST}:8443`)).toBe('beta')
    expect(serverChannelForDb('not a url')).toBe('beta')
    expect(serverChannelForDb(null)).toBe('beta')
    expect(serverChannelForDb(undefined)).toBe('beta')
  })
})
