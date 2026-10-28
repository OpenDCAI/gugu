// #6264 `gugu-server login --grant-stdin --name d22`:桌面带来人填的 SSH 别名 / 主机,
// 记进这个账号的 connect-via(账号进程第一次心跳据此报名字),已有的设备行还叫 `Linux 2` 的换成它。
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const layout = vi.hoisted(() => ({ writeServerConnectVia: vi.fn() }))
const devices = vi.hoisted(() => ({ adoptDeviceName: vi.fn(async () => true) }))

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0' }, safeStorage: {} }))
vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({ writeStoredServerSession: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', () => ({
  applyAccountEnv: vi.fn(),
  accountDataDir: (userId: string) => `/data/${userId}`,
  clearSignedOutMark: vi.fn(),
  emailFromAccessToken: () => 'me@x.y',
  listAccounts: () => [],
  writeAccountMeta: vi.fn(),
  writeServerConnectVia: layout.writeServerConnectVia,
}))
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/core')>()),
  resolveLocalDeviceId: async () => 'dev-1',
  resolveServerMachineId: async () => 'machine-1',
}))
vi.mock('@gugu/core/cloud/devices', () => devices)

const saved = { ...process.env }
const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!

afterEach(() => {
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
