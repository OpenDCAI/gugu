/**
 * `gugu-server login`:服务器上没有浏览器时的登录(product spec 第 2 条)。
 *
 * 终端打出一个链接和一串短码;人在手机或电脑上打开、用邮箱验证码登录、看清是哪台机器后点「允许」;
 * 这里轮询到批准,拿一次性的 magiclink token_hash 向 GoTrue 换**这台 server 自己的**会话链,
 * 加密存进数据目录。正在跑的 server 发现会话文件出现就自己接上(见 server-auth.ts 的 watch)。
 *
 * 轮询遵守 RFC 8628:按服务端给的间隔;收到 slow_down 就把间隔加 5 秒;access_denied / expired_token 停。
 *
 * `gugu-server login --grant-stdin`:桌面经 SSH 一步装好时用(product spec「从桌面用 SSH 一步装好」)。
 * 桌面以自己登着的身份向 server-login/grant 要一条**已批准**的请求,把取件凭证(device_code)从 SSH 的
 * 标准输入递进来 —— ❌ 不走命令行参数(ps 看得见)、❌ 不走环境变量;这里跳过「打链接 + 短码」,直接进同一个 poll。
 * 结果另打一行机器可读的标记(见 LOGIN_RESULT_MARK),桌面据此显示「登上了谁、这台机器上还登着谁」。
 *
 * #6264 机器上限:start 与 poll 都带上这台的 machine_id(与设备行同一个),云端据此判「是不是新机器、超没超上限」。
 * 超了 poll 回 machine_limit(limit / used / max):这里说成人话;桌面那条另打 `LOGIN_ERROR_MARK machine_limit {json}`。
 */
import { REMOTE_TUNNEL_OPEN, SERVER_LOGIN_ACTION } from '@gugu/core/cloud/remoteTunnel'
import os from 'node:os'
import { app } from 'electron'
import {
  MACHINE_LIMIT_ERROR,
  MACHINE_LIMIT_NEXT_STEP,
  machineLimitMessage,
  parseMachineLimitRefusal,
  resolveLocalDeviceId,
  resolveServerMachineId,
  userIdFromSupabaseAccessToken,
  type DeviceHeartbeatTableClient,
} from '@gugu/core'
import { adoptDeviceName, type DeviceLabelClient } from '@gugu/core/cloud/devices'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { writeStoredServerSession } from './server-auth'
import { accountDataDir, applyAccountEnv, clearSignedOutMark, emailFromAccessToken, listAccounts, writeAccountMeta, writeServerConnectVia } from './server-layout'

type StartResponse = { device_code: string; user_code: string; expires_in: number; interval: number }

function functionsUrl(path: string): string {
  return `${getSupabaseUrl().replace(/\/$/, '')}/functions/v1/server-login${path}`
}

/** 这台 server 的机器标识;读不到(安装目录不可写之类)就不报 —— 云端照旧放行,由设备行那一道兜住。 */
async function machineIdOrNull(): Promise<string | null> {
  try {
    return await resolveServerMachineId(process.env)
  } catch {
    return null
  }
}

function machineInfo(machineId: string | null): Record<string, string> {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    user = process.env.USER ?? ''
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    user,
    version: app.getVersion(),
    ...(machineId ? { machine_id: machineId } : {}),
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: getSupabaseAnonKey() },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, data }
}

/** 用一次性 token_hash 向 GoTrue 换一条全新的会话(access + refresh)。 */
async function exchangeTokenHash(tokenHash: string, type: string): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch(`${getSupabaseUrl().replace(/\/$/, '')}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: getSupabaseAnonKey() },
    body: JSON.stringify({ type, token_hash: tokenHash }),
  })
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; msg?: string }
  if (!response.ok || !data.access_token || !data.refresh_token) {
    throw new Error(`换取登录会话失败(${response.status}): ${data.msg ?? JSON.stringify(data)}`)
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}

/**
 * 这个账号的进程上线后在「在哪跑」里会是哪台设备(#6264:桌面据此记下「这台是用 SSH 装上的」,
 * 它的「编程」会话才能直连出终端)。
 *
 * 用的是账号进程**同一个**解析函数、同一套输入:数据目录已经指到这个账号(applyAccountEnv 之后),
 * tier 与 main.ts 同一个来源(server 入口已设 GUGU_TIER);云端已有这台机器这个人的设备行就沿用它。
 * 解析不出来(网络抖了)⇒ null:装机照旧成功,只是这台机器在这张桌面上暂时只有「通用」。
 */
export async function deviceIdForAccount(userId: string, accessToken: string): Promise<string | null> {
  try {
    const heartbeatClient = createGuguSupabaseClient({
      schema: 'identity',
      headers: { Authorization: `Bearer ${accessToken}` },
    }) as unknown as DeviceHeartbeatTableClient
    return await resolveLocalDeviceId({ userId, heartbeatClient, env: process.env })
  } catch {
    return null
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 桌面经 SSH 读的两行标记。❌ 改名:桌面那边(electron/server/ssh-install)按字面找它们。 */
export const LOGIN_RESULT_MARK = '__GUGU_LOGIN_RESULT__'
export const LOGIN_ERROR_MARK = '__GUGU_LOGIN_ERROR__'

type Out = (line: string) => void
const defaultOut: Out = (l) => process.stdout.write(`${l}\n`)

/** 从标准输入读第一行(桌面递进来的 device_code)。读到 EOF 还没有换行也算。 */
async function readFirstStdinLine(): Promise<string> {
  let buffered = ''
  for await (const chunk of process.stdin) {
    buffered += String(chunk)
    const newline = buffered.indexOf('\n')
    if (newline >= 0) return buffered.slice(0, newline).trim()
    if (buffered.length > 4096) break
  }
  return buffered.trim()
}

/** 远程隧道暂不开放、交互登录被关掉(install.sh 据此不再补一句「登录没完成」)。 */
export const LOGIN_EXIT_TUNNEL_CLOSED = 3

export async function runServerLogin(out: Out = defaultOut, args: readonly string[] = []): Promise<number> {
  // #6264 人给这台机器的名字(桌面经 SSH 带来的别名,或手敲的 `--name`):两种登法都按它命名。
  const nameAt = args.indexOf('--name')
  const name = nameAt >= 0 ? args[nameAt + 1]?.trim() || null : null
  if (args.includes('--grant-stdin')) {
    const deviceCode = await readFirstStdinLine()
    // device_code 是 base64url;形状不对就当场说,❌ 拿去 poll 换一个含糊的 invalid_request。
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(deviceCode)) {
      out(`${LOGIN_ERROR_MARK}invalid_grant`)
      out('标准输入里没有有效的登录凭证。')
      return 1
    }
    return pollUntilDone(out, deviceCode, 1000, Date.now() + 5 * 60 * 1000, true, await machineIdOrNull(), name)
  }
  // 链接 + 短码是远程隧道的入口;暂不开放时说清该怎么加这台机器,❌ 发一条谁也用不上的登录请求。
  if (!REMOTE_TUNNEL_OPEN) {
    out('远程隧道暂未开放。')
    out(`请${SERVER_LOGIN_ACTION}。`)
    return LOGIN_EXIT_TUNNEL_CLOSED
  }
  const machineId = await machineIdOrNull()
  const started = await postJson(functionsUrl('/start'), { machine: machineInfo(machineId) })
  if (started.status !== 200) {
    out(`登录请求没发出去(${started.status}): ${JSON.stringify(started.data)}`)
    return 1
  }
  const start = started.data as unknown as StartResponse
  const link = `${functionsUrl('')}?code=${encodeURIComponent(start.user_code)}`
  out('')
  out('打开链接,登录你的咕咕账号:')
  out('')
  out(`  ${link}`)
  out('')
  out(`短码:${start.user_code}(${Math.round(start.expires_in / 60)} 分钟内有效)`)
  out('')
  out(`核对页面上的机器名是 ${os.hostname()},再点「允许」。`)
  out('不是你自己发起的,别点允许。')
  out('')
  out('等待确认…')

  return pollUntilDone(out, start.device_code, Math.max(1, start.interval) * 1000, Date.now() + start.expires_in * 1000, false, machineId, name)
}

async function pollUntilDone(
  out: Out,
  deviceCode: string,
  initialIntervalMs: number,
  deadline: number,
  fromGrant: boolean,
  machineId: string | null,
  name: string | null = null,
): Promise<number> {
  let interval = initialIntervalMs
  // 桌面递来的是已批准的请求:第一轮不必先等。
  let first = fromGrant
  while (Date.now() < deadline) {
    if (!first) await sleep(interval)
    first = false
    const polled = await postJson(functionsUrl('/poll'), { device_code: deviceCode, ...(machineId ? { machine_id: machineId } : {}) })
    if (polled.status === 200 && typeof polled.data.token_hash === 'string') {
      const tokens = await exchangeTokenHash(polled.data.token_hash, String(polled.data.type ?? 'magiclink'))
      const userId = userIdFromSupabaseAccessToken(tokens.accessToken)
      if (!userId) throw new Error('登录令牌里没有用户 id(sub)')
      const email = emailFromAccessToken(tokens.accessToken)
      const others = listAccounts().filter((account) => account.signedIn && account.userId !== userId)
      // 知道是谁之后才把数据目录指到这个账号自己的目录,再落登录态(替身的 userData 第一次读到就缓存住)。
      applyAccountEnv(userId)
      writeAccountMeta(userId, email)
      writeStoredServerSession(tokens)
      // 重新登上了:之前「登录已失效 / 被移除」的说法作废。
      clearSignedOutMark(accountDataDir(userId))
      // #6264 远程 SSH(桌面经 SSH 递来的凭证)/ 远程隧道(一行命令 + 确认页):最近一次登录说了算。
      // 名字随它一起记:账号进程第一次心跳据此报名字(core/cloud/serverConnectVia.ts serverDeviceLabel)。
      writeServerConnectVia(accountDataDir(userId), fromGrant ? 'ssh' : 'tunnel', { name })
      const deviceId = fromGrant || name ? await deviceIdForAccount(userId, tokens.accessToken) : null
      // 这一行早就有了(重装 / 重新登录)、名字还是库取的 `Linux 2`:换成人给的名字。改不成不挡登录。
      if (deviceId && name) {
        const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${tokens.accessToken}` } })
        await adoptDeviceName(client as unknown as DeviceLabelClient, deviceId, name).catch(() => false)
      }
      if (fromGrant) {
        out(
          `${LOGIN_RESULT_MARK}${JSON.stringify({
            userId,
            email,
            others: others.map((account) => account.email ?? account.userId),
            deviceId,
          })}`,
        )
      }
      out(`已登录 ${email ?? userId}。`)
      if (others.length > 0) {
        out(`同时登录:${others.map((account) => account.email ?? account.userId).join('、')}`)
      }
      out('上线后会出现在咕咕的设备列表里。未在后台运行时,执行 gugu-server service install。')
      return 0
    }
    const error = String(polled.data.error ?? '')
    if (error === 'authorization_pending') continue
    if (error === MACHINE_LIMIT_ERROR) {
      const refusal = parseMachineLimitRefusal(polled.data)
      if (fromGrant) out(`${LOGIN_ERROR_MARK}${MACHINE_LIMIT_ERROR} ${JSON.stringify(refusal ?? {})}`)
      out(`没有登上:${machineLimitMessage(refusal)}`)
      out(MACHINE_LIMIT_NEXT_STEP)
      return 1
    }
    if (fromGrant && error !== 'slow_down') out(`${LOGIN_ERROR_MARK}${error || `http_${polled.status}`}`)
    if (error === 'slow_down') {
      interval += 5000
      continue
    }
    if (error === 'access_denied') {
      out('登录被拒绝。')
      return 1
    }
    if (error === 'expired_token') {
      out('短码已过期,请重新执行 gugu-server login。')
      return 1
    }
    out(`登录出错(${polled.status}): ${JSON.stringify(polled.data)}`)
    return 1
  }
  if (fromGrant) out(`${LOGIN_ERROR_MARK}expired_token`)
  out('短码已过期,请重新执行 gugu-server login。')
  return 1
}
