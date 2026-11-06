// #6264 `gugu-server login --grant-stdin --name d22`:桌面带来人填的 SSH 别名 / 主机,
// 记进这个账号的 connect-via(账号进程第一次心跳据此报名字),已有的设备行还叫 `Linux 2` 的换成它。
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const layout = vi.hoisted(() => ({ writeServerConnectVia: vi.fn(), accounts: [] as ServerAccount[], checkLayout: vi.fn() }))
const devices = vi.hoisted(() => ({ adoptDeviceName: vi.fn(async () => true), restartServerAfterLogin: vi.fn() }))

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0' }, safeStorage: {} }))
vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({ writeStoredServerSession: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', () => ({
  applyAccountEnv: vi.fn(),
  accountDataDir: () => '/data/u1',
  serverHome: () => '/installation',
  clearSignedOutMark: vi.fn(),
  emailFromAccessToken: () => 'me@x.y',
  readServerAccount: () => layout.accounts[0] ?? null,
  writeAccountMeta: vi.fn(),
  writeServerConnectVia: layout.writeServerConnectVia,
}))
vi.mock('../../../../apps/desktop/electron/server/server-boot.cjs', () => ({ prepareAccountLogin: vi.fn(), assertAccountLayoutReady: layout.checkLayout }))
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/core')>()),
  resolveLocalDeviceId: async () => 'dev-1',
  resolveServerMachineId: async () => 'machine-1',
}))
vi.mock('@gugu/core/cloud/devices', () => devices)
vi.mock('../../../../apps/desktop/electron/server/server-service', () => ({ restartServerAfterLogin: devices.restartServerAfterLogin }))

const saved = { ...process.env }
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

afterEach(() => {
  layout.accounts = []
  layout.checkLayout.mockReset()
  process.env = { ...saved }
  Object.defineProperty(process, 'stdin', stdin)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1', email: 'me@x.y' })).toString('base64url')}.y`

async function login(args: string[]) {
  process.env.GUGU_SUPABASE_URL = 'https://db.example.test'
  process.env.GUGU_SUPABASE_ANON_KEY = 'anon'
  Object.defineProperty(process, 'stdin', { value: Readable.from([`${'d'.repeat(43)}\n`]), configurable: true })
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).endsWith('/poll')
      ? new Response(JSON.stringify({ token_hash: 'th', type: 'magiclink' }), { status: 200 })
      : String(url).endsWith('/start')
        ? new Response(JSON.stringify({ device_code: 'dc', user_code: 'ABCD', expires_in: 600, interval: 0 }), { status: 200 })
        : new Response(JSON.stringify({ access_token: jwt, refresh_token: 'r' }), { status: 200 }),
  ))
  const { runServerLogin } = await import('../../../../apps/desktop/electron/server/server-login')
  return runServerLogin(() => undefined, args)
}

describe('#6264 gugu-server login --grant-stdin --name', () => {
  it('refuses an unmigrated layout before consuming the grant or requesting tokens', async () => {
    layout.checkLayout.mockImplementation(() => { throw new Error('Run gugu-server start to migrate one@example.test') })
    expect(await login(['--grant-stdin'])).toBe(78)
    expect(fetch).not.toHaveBeenCalled()
    expect(layout.writeServerConnectVia).not.toHaveBeenCalled()
  })

  it('refuses an already signed-in installation before consuming the grant or requesting tokens', async () => {
    layout.accounts = [{ userId: 'existing', email: 'existing@example.test', signedIn: true, addedAt: null,
      dir: '', dataDir: '', homeDir: '', signedOut: null }]
    expect(await login(['--grant-stdin'])).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(layout.writeServerConnectVia).not.toHaveBeenCalled()
  })

  it('starts the server after login unless a controller owns the install', async () => {
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(devices.restartServerAfterLogin).toHaveBeenCalledOnce()
    devices.restartServerAfterLogin.mockClear()
    process.env.GUGU_CLOUD_COMPUTER = '1'
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(devices.restartServerAfterLogin).not.toHaveBeenCalled()
  })

  it('allows a signed-out account to authenticate again', async () => {
    layout.accounts = [{ userId: 'u1', email: 'me@x.y', signedIn: false, addedAt: null,
      dir: '', dataDir: '', homeDir: '', signedOut: null }]
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(fetch).toHaveBeenCalled()
  })
  it('名字记进 connect-via,已有的设备行交给 adoptDeviceName', async () => {
    expect(await login(['--grant-stdin', '--name', 'd22'])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith('/data/u1', 'ssh', { name: 'd22' })
    expect(devices.adoptDeviceName).toHaveBeenCalledWith(expect.anything(), 'dev-1', 'd22')
  })

  it('没带名字(老桌面):照旧登录,不记名字、不改名', async () => {
    expect(await login(['--grant-stdin'])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith('/data/u1', 'ssh', { name: null })
    expect(devices.adoptDeviceName).not.toHaveBeenCalled()
  })
})

describe('gugu-server login --name(链接 + 短码那条路)', () => {
  it('名字同样记进 connect-via,已有的设备行同样交给 adoptDeviceName', async () => {
    expect(await login(['--name', 'juma2'])).toBe(0)
    expect(layout.writeServerConnectVia).toHaveBeenCalledWith('/data/u1', 'tunnel', { name: 'juma2' })
    expect(devices.adoptDeviceName).toHaveBeenCalledWith(expect.anything(), 'dev-1', 'juma2')
  })
})
