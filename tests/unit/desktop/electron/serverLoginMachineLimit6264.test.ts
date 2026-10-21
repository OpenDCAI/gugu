// #6264 `gugu-server login` 碰到机器上限:start / poll 都报上这台的 machine_id(与设备行同一个),
// 云端回 machine_limit 时在终端里说人话(哪条上限、用了几台、下一步去哪),❌ 当成「登录出错」吐一段 JSON。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 交互登录(链接 + 短码)是远程隧道的入口,暂不开放;这一条守着开放后的上限提示,所以把开关拨到「开」。
// 关着时的样子见下面「远程隧道暂不开放」。
const tunnel = vi.hoisted(() => ({ open: true }))
vi.mock('@gugu/core/cloud/remoteTunnel', () => ({
  get REMOTE_TUNNEL_OPEN() {
    return tunnel.open
  },
  SERVER_LOGIN_ACTION: '在咕咕桌面「设置 → 设备 → 添加一台机器」用远程 SSH 添加这台机器',
}))
vi.mock('electron', () => ({ app: { getVersion: () => '0.3.0' }, safeStorage: {} }))
vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({ writeStoredServerSession: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/server/server-layout', () => ({
  applyAccountEnv: vi.fn(),
  emailFromAccessToken: vi.fn(),
  listAccounts: () => [],
  writeAccountMeta: vi.fn(),
}))

const saved = { ...process.env }
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-server-login-limit-'))
  process.env.GUGU_SERVER_MODE = '1'
  process.env.GUGU_SERVER_HOME = home
  process.env.GUGU_SUPABASE_URL = 'https://db.example.test'
  process.env.GUGU_SUPABASE_ANON_KEY = 'anon'
})

afterEach(async () => {
  process.env = { ...saved }
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

describe('#6264 gugu-server login × 机器上限', () => {
  it('报上 machine_id;被上限拒时说清是哪条上限、用了几台、去哪移除或升级,退出码 1', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      if (url.endsWith('/start')) {
        return new Response(JSON.stringify({ device_code: 'd'.repeat(43), user_code: 'ABCD-EFGH', expires_in: 900, interval: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'machine_limit', limit: 'tunnel', used: 3, max: 3, plan: 'default' }), { status: 400 })
    }))
    const { runServerLogin } = await import('../../../../apps/desktop/electron/server/server-login')
    const lines: string[] = []
    const code = await runServerLogin((line) => lines.push(line))

    expect(code).toBe(1)
    const installId = (await readFile(join(home, 'install-id'), 'utf8')).trim()
    expect(installId).not.toBe('')
    expect((bodies[0].machine as Record<string, unknown>).machine_id).toBe(installId)
    expect(bodies[1]).toMatchObject({ device_code: 'd'.repeat(43), machine_id: installId })
    const out = lines.join('\n')
    expect(out).toContain('没有登上:经咕咕云连接（远程隧道）的咕咕 server 最多 3 台，你已经连了 3 台。')
    expect(out).toContain('「设置 → 设备」里移除一台不用的机器')
    expect(out).toContain('「设置 → 会员与额度」升级会员')
    expect(out).not.toContain('登录出错')
  })
})

describe('远程隧道暂不开放(当前默认):gugu-server login', () => {
  afterEach(() => {
    tunnel.open = true
  })

  it('不发登录请求,说清改用咕咕桌面经远程 SSH 添加;退出码 3(install.sh 据此不再补「登录没完成」)', async () => {
    tunnel.open = false
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { runServerLogin, LOGIN_EXIT_TUNNEL_CLOSED } = await import('../../../../apps/desktop/electron/server/server-login')
    const lines: string[] = []
    const code = await runServerLogin((line) => lines.push(line))
    expect(code).toBe(LOGIN_EXIT_TUNNEL_CLOSED)
    expect(code).toBe(3)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(lines.join('\n')).toBe('远程隧道暂未开放。\n请在咕咕桌面「设置 → 设备 → 添加一台机器」用远程 SSH 添加这台机器。')
  })
})
