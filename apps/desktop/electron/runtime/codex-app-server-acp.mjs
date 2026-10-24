#!/usr/bin/env node
import { codexTerminalUpdate } from './codex-terminals.mjs'

// Thin protocol adapter: preserve Gugu's ACP host contract while running the user's own Codex app-server.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { GUGU_MCP_CONFIG_KEY, normalizeGuguToolName } from '../mcp/gugu-mcp-name.mjs'
import { joinPromptText, promptInputItems } from './codex-app-server-prompt.mjs'
import { codexForkHandoffItems } from './codex-fork-handoff.mjs'
import { memoizeSuccess, writeCodexModelCatalog } from './codex-model-catalog.mjs'
// esbuild 把它打进 dist-electron/runtime;单测里 node 直接跑这份源码,所以写 `.ts` 全路径。
import { spawnOwnedChild } from '../../../../packages/session-core/src/exec/owned-child.ts'
import { codexReasoningText } from '../../../../packages/core/src/shared/reasoningText.mjs'
import { codexFilePatches } from '../../../../packages/session-core/src/acp/transport/codex-file-patches.ts'
import { createCodexSubagents } from './codex-subagents.mjs'

const codexBin = process.env.GUGU_CODEX_BIN?.trim()
if (!codexBin) {
  process.stderr.write('[codex-app-server-acp] GUGU_CODEX_BIN is required\n')
  process.exit(2)
}

/** The app-server as an owned tree (`codex.cmd` on Windows is a cmd.exe shell over codex). */
let appServer = null
let app = null
let appReader = null
let appNextId = 1
let appReady = false
let sessionId = null
let appServerThreadConfig = null
let activeCycle = null
/** `/compact` 已交给 codex、压缩那一轮还没报 `turn/started` 时,在等它的那条 ACP 请求 id。 */
let compactInsertion = null
let established = false
let revertingHistory = false
let historyCanRevert = false
/**
 * 用户在下拉里选中的权限档(codex 内置 profile id)。只用于让界面回显当前档,
 * **不**参与下发 —— 下发走 `thread/settings/update`,由 codex 自己持有生效状态。
 */
let selectedPermissionProfile = null
/**
 * 线程当前的模型与推理档。
 * 来源是 `thread/start` / `thread/resume` / `thread/fork` 回包的**顶层** `model` /
 * `reasoningEffort`(❌ 不在 `result.thread` 里,那层没有这两项)。
 */
let selectedModel = null
let selectedEffort = null
/** `model/list` 读成功的结果。对同一个 app-server 进程是常量,缓存住。 */
let modelCatalog = null
/**
 * 这台 codex **根本没有** `model/list` 这个方法(`-32601`)。
 * 这件事对同一个进程也是常量,记住它,免得每次切档都再问一遍。
 */
let modelCatalogUnsupported = false
/** 正在读的那一趟。并发调用共用它,❌ 不要同时发两趟 `model/list`。 */
let modelCatalogInFlight = null

/**
 * The host puts the platform model declaration on this adapter's argv so the child app-server
 * receives it as native Codex config. Codex 0.153 can still report its bundled fallback metadata
 * in `thread/tokenUsage/updated` (for example 258400 for an unknown gateway alias), so the ACP
 * surface must use the same explicit declaration when it renders the context window.
 */
function configuredContextWindow(argv = process.argv) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== '-c') continue
    const value = String(argv[index + 1] ?? '').match(/^model_context_window=(\d+)$/)?.[1]
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return null
}

const declaredContextWindow = configuredContextWindow()

/**
 * @@@resume-provider — **这个进程**为一条新线程会用的那个 model provider。
 *
 * ## 为什么 resume 必须显式带上它
 *
 * codex 把线程创建时的 `model_provider` **写进 rollout**,`thread/resume` 又是拿
 * rollout 里那份配置重新 load 的 ⇒ 跨计费路重开(咕咕代付 ↔ 用户自己的订阅)时:
 *  · 新进程没有咕咕那条 provider 的声明 ⇒ `failed to load configuration: Model provider
 *    `gugu_platform` not found`,resume 直接被拒(gugu#5825,owner 真机撞到);
 *  · 就算把声明补上,线程**仍然绑在那条 provider 上** —— 下一轮会拿用户自己的 key 打咕咕的中转。
 *
 * 官方 API 给的正解是 `thread/resume` 的**顶层** `modelProvider` 参数(`thread_resume(…,
 * model_provider=None, …)`,线上 camelCase),它作为 **request override** 参与配置加载
 * (`thread_processor.rs` 的 `thread_resume_inner` → `config_manager.load_for_cwd(request_overrides, …)`)。
 * ⚠️ ❌ 不是 `config.model_provider` —— `config` 那个口是给 `model_reasoning_effort` 这类用的,
 *    塞进去**收下但不生效**(0.147.0 实测:三种字段名 + `config` 里那份全部无效)。
 *
 * ## 取值:问这个进程自己,❌ 不判「平台还是 BYOK」
 *
 * 规则只有一条:**resume 用这个进程的 provider,而不是 rollout 里记的那个** ——
 * 进程握着谁的凭据,这条会话就该走谁的路。所以不需要在这里再分一次平台/BYOK 的岔:
 * `thread/start` 回包**顶层**就有 `modelProvider`,平台进程报 `gugu_platform`、BYOK 进程报它自己的默认。
 * 没有现成的 `thread/start` 可蹭时,起一条 `ephemeral: true` 的线程问一次 —— 实测它**不落 rollout**,
 * 不污染用户的会话库。
 *
 * 值**原样透传**,❌ 不规范化大小写:实测默认那条报的是 `OpenAI`,而 resume 收的就是这个串。
 */
let processModelProvider = null
let processModelProviderKnown = false
/**
 * 在途的那一趟。并发的 `session/load` 共用它 —— ⚠️ ❌ 不能只记一个 boolean:
 * 后来那条会拿到**还没填好的 `null`**,于是它既丢掉 override,又因为少了一个往返而抢在
 * 前一条之前 resume,把「哪一次 load 是第一次」整个打乱(既有的 stale-load 判据当场红)。
 */
let processModelProviderInFlight = null

function processModelProviderOnce(cwd) {
  if (processModelProviderKnown) return Promise.resolve(processModelProvider)
  if (!processModelProviderInFlight) {
    processModelProviderInFlight = appRequest('thread/start', { cwd, ephemeral: true }, 45_000)
      .then((probe) => String(probe?.modelProvider ?? '').trim() || null)
      .catch((error) => {
        // ❌ 不抛:问不出来只是退回改动前的行为(resume 沿用 rollout 里那条),
        //    而抛出去会让**每一条**会话都打不开 —— 拿更大的故障盖小故障。
        process.stderr.write(
          `[codex-app-server-acp] could not read this process's model provider: ${error?.message ?? error}\n`,
        )
        return null
      })
      .then((value) => {
        processModelProvider = value
        processModelProviderKnown = true
        processModelProviderInFlight = null
        return value
      })
  }
  return processModelProviderInFlight
}

async function modelCatalogOnce() {
  if (modelCatalog) return modelCatalog
  // 平台会话的模型(连同网关的推理档)由 codex 自己报:它们写在这座桥交给 app-server 的
  // model catalog 里(`codex-model-catalog.mjs`),所以这里没有第二份清单要合并。
  if (modelCatalogUnsupported) return []
  if (!modelCatalogInFlight) {
    modelCatalogInFlight = loadModelCatalog()
      .then((models) => {
        modelCatalog = models
        return modelCatalog
      })
      .catch((error) => {
        // ❌ 不抛:目录读不到只是「选不了模型」,升级成「会话起不动」是拿更大的故障盖小故障。
        //    但必须在 stderr 留痕,否则下次协议改名又变成只能靠截图发现的 UI 症状。
        process.stderr.write(`gugu codex-acp: model/list failed: ${error?.message ?? error}\n`)
        // ⚠️ 两种失败必须分开记,❌ 别一律缓存成空目录:
        //  · `-32601` = 这台 codex 没有这个方法 —— 常量,记住。
        //  · 其它(超时 / 传输 / 形状坏)—— **瞬时**。一次 45s 抖动若被缓存成 `[]`,
        //    往后每次都短路(空数组是 truthy),整条会话的模型下拉就永久空了 ——
        //    用户看到的症状与本 PR 要修的那个 bug 一模一样。所以不记,下次再问。
        if (error?.code === -32601) modelCatalogUnsupported = true
        return []
      })
      .finally(() => {
        modelCatalogInFlight = null
      })
  }
  return modelCatalogInFlight
}
let shuttingDown = false
// 每次 session/load 自增。宿主 load 超时后会重发(acpSessionLifecycle 的 LOAD_RETRY_DELAYS_MS),
// 而适配器对 ACP 请求不串行化 ⇒ 老那次的重放必须认出自己已经过期并闭嘴,否则两份历史交错写同一条会话。
let loadGeneration = 0
const appPending = new Map()
// 流过增量的条目(→ 最近一段增量的段号):`item/completed` 时不再整条补发。有的模型思考不流增量,整条只在 completed 里(#6830)。
const streamedItems = new Map()
const toolOutcomesByTurn = new Map()
// itemId → native command. A null turnId means the turn ended and the host owns a background task.
const runningCommands = new Map()

const acpTestAuditPath = process.env.GUGU_SESSION_TEST_HOOKS === '1'
  ? process.env.GUGU_CODEX_ACP_TEST_AUDIT_PATH?.trim()
  : undefined

function auditAcpRequest(method, params) {
  if (!acpTestAuditPath) return
  appendFileSync(
    acpTestAuditPath,
    `${JSON.stringify({
      at: Date.now(),
      method,
      sessionId: typeof params?.sessionId === 'string' ? params.sessionId : null,
    })}\n`,
    { mode: 0o600 },
  )
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result, error) {
  write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params })
}

// ── 通向人的那一段(#3813 askUser) ────────────────────────────────────────────
// 桥对 host 侧原本只有 `respond`(答别人问的)和 `notify`(单向通知)—— **没有**「自己发问、
// 等一个回答」的通道,而 stdin 那边 `message.id !== undefined && message.method` 的分派也把
// 「只有 id、没有 method」的**响应**整类静默丢掉了。两处合起来的后果是:桥在物理上收不到
// 人的回答,于是 `item/tool/requestUserInput` 只能自己编一个 —— 这才是那个启发式的来历。
// 下面这三个函数就是补上的那一半;codex 侧的 `appRequest` 是同一形状的镜像。
let acpNextId = 1
const acpPending = new Map()

// ⚠️ **故意不设超时。** 这条请求的语义就是「停下来等人」,人隔几分钟才回是正常的;
//    到点自己填一个答案,正是这一修要拆掉的东西。收尾交给 `session/cancel` 与进程退出。
function acpRequest(method, params) {
  const id = acpNextId++
  return new Promise((resolve, reject) => {
    acpPending.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function settleAcpResponse(message) {
  const pending = acpPending.get(message.id)
  if (!pending) return false
  acpPending.delete(message.id)
  if (message.error !== undefined) {
    pending.reject(new Error(String(message.error?.message ?? 'ACP request failed')))
  } else pending.resolve(message.result)
  return true
}

function cancelAcpPending(reason) {
  for (const pending of acpPending.values()) pending.reject(new Error(reason))
  acpPending.clear()
}

function appWrite(message) {
  if (!app?.stdin.writable) throw new Error('local Codex app-server stdin is not writable')
  app.stdin.write(`${JSON.stringify(message)}\n`)
}

function appRequest(method, params, timeoutMs = 45_000) {
  const id = appNextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      appPending.delete(id)
      reject(new Error(`local Codex app-server ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    appPending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    appWrite({ id, method, params })
  })
}

function appNotify(method, params) {
  appWrite({ method, params })
}

function rejectAppPending(error) {
  for (const pending of appPending.values()) pending.reject(error)
  appPending.clear()
}

const LOOPBACK_MCP_HOSTS = ['127.0.0.1', 'localhost', '::1']

function appendNoProxy(env, hosts) {
  const entries = new Set(
    [env.NO_PROXY, env.no_proxy]
      .flatMap((value) => String(value ?? '').split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  )
  for (const host of hosts) entries.add(host)
  const value = [...entries].join(',')
  env.NO_PROXY = value
  env.no_proxy = value
}

function hasLoopbackMcp(servers) {
  return (servers ?? []).some((server) => {
    try {
      const host = new URL(String(server?.url ?? '')).hostname.replace(/^\[|\]$/g, '').toLowerCase()
      return LOOPBACK_MCP_HOSTS.includes(host)
    } catch {
      return false
    }
  })
}

/**
 * ACP 线上的 mcpServers → 原生 thread-open `config` 覆盖。
 *
 * Only streamable HTTP MCP servers are accepted. Bearer values stay in env; config carries the name.
 */
function mcpConfig(servers) {
  const config = {}
  const env = {}
  const keys = new Set()
  for (const server of servers ?? []) {
    const key = String(server.name ?? '').replace(/[^A-Za-z0-9_]/g, '_')
    if (!key || keys.has(key)) throw new Error(`duplicate or empty Codex MCP server key: ${key || '<empty>'}`)
    keys.add(key)
    const url = String(server.url ?? '')
    if (!url) throw new Error(`Codex MCP server ${key} has no url (stdio MCP servers are no longer supported)`)
    config[`mcp_servers.${key}.url`] = url
    // 问题 9:宿主交出的 server 都是咕咕发的,不逐次问(Codex 缺省按注解判,没注解就问)。
    config[`mcp_servers.${key}.default_tools_approval_mode`] = 'approve'
    for (const header of server.headers ?? []) {
      const name = String(header.name ?? '')
      if (name.toLowerCase() !== 'authorization') continue
      const envName = `GUGU_MCP_BEARER_${key.toUpperCase()}`
      const value = String(header.value ?? '').replace(/^Bearer\s+/i, '')
      if (env[envName] !== undefined && env[envName] !== value) {
        throw new Error(`conflicting MCP bearer value for ${envName}`)
      }
      env[envName] = value
      config[`mcp_servers.${key}.bearer_token_env_var`] = envName
    }
  }
  // The materializer supplies disabled servers and the session-owned bearer env
  // names through this private child env. Flatten it into the same dotted map so
  // the app-server sees one native override layer and no MCP argv assignments.
  const rawFragment = process.env.GUGU_CODEX_MCP_CONFIG?.trim()
  if (rawFragment) {
    let fragment
    try {
      fragment = JSON.parse(rawFragment)
    } catch (error) {
      throw new Error(`GUGU_CODEX_MCP_CONFIG is not valid JSON: ${error?.message ?? error}`)
    }
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
      throw new Error('GUGU_CODEX_MCP_CONFIG must be an object')
    }
    for (const [key, values] of Object.entries(fragment)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error(`GUGU_CODEX_MCP_CONFIG server '${key}' must be an object`)
      }
      for (const [field, value] of Object.entries(values)) {
        config[`mcp_servers.${key}.${field}`] = value
      }
    }
  }
  // @@@5380 agent 事件 hook 的 `notify` 回调走**同一张 map**。
  //
  // 它原本(#5301)是拼在 argv 上的 `-c notify=…`,靠桥把 argv 原样转发给 `codex app-server`;
  // 而 #5363 已经把 MCP 从 argv 迁到这张原生 config —— 两条并存就是同一个进程两扇门。
  // 少了这一份,这条腿一条 hook 事件都发不出来 ⇒ 没有 `stop` ⇒ **跑完没有系统横幅**。
  // ❌ 不给默认值:没递就是没递(上游 codex-acp 那条腿本来就不该有),猜一份等于伪造出处标记。
  const rawNotify = process.env.GUGU_CODEX_NOTIFY_CONFIG?.trim()
  if (rawNotify) {
    let notify
    try {
      notify = JSON.parse(rawNotify)
    } catch (error) {
      throw new Error(`GUGU_CODEX_NOTIFY_CONFIG is not valid JSON: ${error?.message ?? error}`)
    }
    if (!Array.isArray(notify) || notify.some((item) => typeof item !== 'string')) {
      throw new Error('GUGU_CODEX_NOTIFY_CONFIG must be an array of strings')
    }
    config.notify = notify
  }
  return { config, env }
}

function hasGuguServer(servers) {
  return (servers ?? []).some((server) => String(server?.name ?? '').replace(/[^A-Za-z0-9_]/g, '_') === GUGU_MCP_CONFIG_KEY)
}

function developerInstructionsFrom(params) {
  const append = params?._meta?.systemPrompt?.append
  return typeof append === 'string' && append.trim() ? { developerInstructions: append } : {}
}

/**
 * The host's Codex materializer puts native thread permission fields in this namespaced ACP
 * metadata. They must stay out of process argv: argv policy masks thread settings in Codex 0.147.
 */
function codexThreadPermissionFrom(params) {
  const raw = params?._meta?.guguCodex
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object') throw new Error('invalid guguCodex session metadata')
  const profile = permissionProfileId(raw.permissionProfile)
  const threadStart = raw.threadStart
  if (!profile || !threadStart || typeof threadStart !== 'object') {
    throw new Error('guguCodex session metadata is missing permissionProfile or threadStart')
  }
  const approvalPolicy = String(threadStart.approvalPolicy ?? '').trim()
  const sandbox = String(threadStart.sandbox ?? '').trim()
  if (!approvalPolicy || !sandbox) {
    throw new Error('guguCodex session metadata has incomplete thread permission')
  }
  return { profile, threadStart: { approvalPolicy, sandbox } }
}

function permissionProfileId(profile) {
  if (typeof profile === 'string') return profile
  if (!profile || typeof profile !== 'object') return null
  return String(profile.id ?? profile.profileId ?? profile.permissionProfileId ?? profile.name ?? '').trim() || null
}

function permissionProfileName(profile, id) {
  if (profile && typeof profile === 'object') {
    const name = String(profile.displayName ?? profile.title ?? profile.name ?? '').trim()
    if (name) return name
  }
  return id
    .replace(/^:+/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim()
}

function permissionProfileDescription(profile) {
  if (!profile || typeof profile !== 'object') return undefined
  const description = String(profile.description ?? profile.displayDescription ?? '').trim()
  return description || undefined
}

function permissionModeConfigOptions(selected, availableModes) {
  if (!selected) return []
  return [{
    configId: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: selected,
    options: availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  }]
}

/**
 * `model/list` 结果里放模型数组的键名,按可信度排序。
 * 与上面权限档那份是同一个教训:❌ 一个键都不认识时不能静默当空列表 —— 那会让
 * 「目录没读到」和「这台 codex 只有一个模型」在界面上完全同形。
 */
const MODEL_LIST_KEYS = ['data', 'models', 'items']

function modelsFromResponse(response) {
  if (!response || typeof response !== 'object') return []
  for (const key of MODEL_LIST_KEYS) {
    const raw = response[key]
    if (raw === undefined || raw === null) continue
    if (Array.isArray(raw)) return raw
    warnModelCatalogShape(`local Codex model/list carried a non-array "${key}"`, response)
    return []
  }
  warnModelCatalogShape('local Codex model/list carried no known model array', response)
  return []
}

function warnModelCatalogShape(what, response) {
  const keys = Object.keys(response).join(', ')
  process.stderr.write(`gugu codex-acp: ${what}; keys=[${keys}]\n`)
}

/**
 * 读这台 codex 真正能用的模型目录。
 *
 * ⚠️ 这就是 #5050 的整个要害:目录必须由**跑会话的这座桥**报出来。从前它由主进程另起一个
 * 上游 codex-acp 探,于是「目录说有 40 个模型」而「会话说我没有模型这一维」,选中的那个
 * 永远落不下去。探测与会话同源之后,列出来的每一条都是这条线程真能应用的。
 */
async function loadModelCatalog(timeoutMs = 45_000) {
  const models = []
  let cursor = null
  let safety = 0
  do {
    const response = await appRequest(
      'model/list',
      { ...(cursor ? { cursor } : {}), limit: 100 },
      timeoutMs
    )
    for (const raw of modelsFromResponse(response)) {
      if (!raw || typeof raw !== 'object') continue
      const id = String(raw.id ?? raw.model ?? '').trim()
      if (!id) continue
      // `hidden` 的条目 codex 自己不给用户挑,我们也不放进下拉。
      if (raw.hidden === true) continue
      const efforts = Array.isArray(raw.supportedReasoningEfforts)
        ? raw.supportedReasoningEfforts
            .map((e) => String(e?.reasoningEffort ?? e ?? '').trim())
            .filter(Boolean)
        : []
      models.push({
        id,
        name: String(raw.displayName ?? id).trim() || id,
        ...(raw.description ? { description: String(raw.description) } : {}),
        efforts,
      })
    }
    cursor = String(response?.nextCursor ?? response?.next_cursor ?? '').trim() || null
    safety += 1
    if (safety > 20) throw new Error('local Codex model/list pagination did not terminate')
  } while (cursor)
  return models
}

/**
 * 跨模型的推理档其实只有一条有序阶梯,各家支持的是它的子集
 * (models.dev 实测:2819/2821 个 effort 型模型都是它的子集)。codex 在 `max` 之上还有 `ultra`。
 */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/**
 * 换模型后当前档带不动时,落到**最近**的一档 —— ❌ 不是列表里的第一个。
 *
 * ⚠️ 这条是真机打回来的:`gpt-5.6-sol` 选 `max`,切到只到 `xhigh` 的 `gpt-5.5`,
 * 取 `efforts[0]` 会落到 **`low`** —— 用户要的是最高推理强度,拿到的是最低,而且悄无声息。
 * 正确的落点是 `xhigh`。
 *
 * 同距时取**低**的那一档:替用户把推理强度往上抬 = 替他多花钱,那不是回落该做的事。
 */
function nearestSupportedEffort(wanted, supported) {
  if (supported.includes(wanted)) return wanted
  const wantedRank = EFFORT_LADDER.indexOf(wanted)
  // 阶梯之外的词谈不上远近(codex 哪天加个新词就会走到这里),退回它自己列的第一档。
  if (wantedRank < 0) return supported[0] ?? null
  let best = null
  let bestDistance = Infinity
  for (const effort of supported) {
    const rank = EFFORT_LADDER.indexOf(effort)
    if (rank < 0) continue
    const distance = Math.abs(rank - wantedRank)
    if (distance < bestDistance || (distance === bestDistance && rank < EFFORT_LADDER.indexOf(best))) {
      best = effort
      bestDistance = distance
    }
  }
  return best ?? supported[0] ?? null
}

function modelConfigOptions(selected, models) {
  if (models.length === 0 || !selected) return []
  return [{
    configId: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: selected,
    options: models.map((model) => ({
      value: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
    })),
  }]
}

/**
 * 推理档。各模型支持的档不同(实测 sol/terra 到 `ultra`,luna 没有 `ultra`,gpt-5.5/5.2 只到
 * `xhigh`),所以档位表跟着**当前模型**走 —— 报一份跟当前模型无关的全集,用户会选到一个这台
 * codex 在这个模型上并不接受的档。
 */
function effortConfigOptions(selectedModelId, selectedEffortId, models) {
  const current = models.find((model) => model.id === selectedModelId)
  const efforts = current?.efforts ?? []
  if (efforts.length === 0 || !selectedEffortId) return []
  return [{
    configId: 'effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: selectedEffortId,
    options: efforts.map((effort) => ({ value: effort, name: effort })),
  }]
}

/** 把 model / thought_level 两组并进 configOptions(已有同 category 的不覆盖)。 */
function withModelConfigOptions(existing, modelSelected, effortSelected, models) {
  const list = Array.isArray(existing) ? [...existing] : []
  const has = (category) =>
    list.some((option) => option && typeof option === 'object' && option.category === category)
  if (!has('model')) list.push(...modelConfigOptions(modelSelected, models))
  if (!has('thought_level')) {
    list.push(...effortConfigOptions(modelSelected, effortSelected, models))
  }
  return list
}

/**
 * `session/set_config_option` 的串行队列。
 * 一次只跑一条,失败也照样往下走(队列本身不因某条被拒而卡死)。
 */
let configOptionQueue = Promise.resolve()

function serializeConfigOption(run) {
  configOptionQueue = configOptionQueue.then(run, run)
  return configOptionQueue
}

function ensurePermissionModeConfigOptions(existing, selected, availableModes) {
  const modeOption = permissionModeConfigOptions(selected, availableModes)
  if (!Array.isArray(existing) || existing.length === 0) return modeOption
  if (existing.some((option) => option && typeof option === 'object' && option.category === 'mode')) {
    return existing
  }
  return [...existing, ...modeOption]
}

/**
 * `permissionProfile/list` 结果里放档位数组的键名,按可信度排序。
 *
 * `data` 是 codex 0.146.0 **真机实测**的键名 —— 裸 `codex app-server` 走
 * initialize → thread/start → permissionProfile/list,回的是
 * `{"data":[{"id":":read-only","description":null,"allowed":true},…],"nextCursor":null}`。
 * 其余几个是当初按命名习惯猜的别名,一个都没猜中:于是三档内置 profile
 * (`:read-only` / `:workspace` / `:danger-full-access`)一条都没到 UI,
 * 下拉只剩 loadPermissionModes() 末尾补的那条当前档。
 *
 * ⚠️ 所以「一个键都不认识」**不能**静默当空列表:空列表会被那条兜底吸收,
 * 「档位没读到」与「codex 就只有一档」在界面上完全同形。走到那一步要在 stderr
 * 留下实际键名,让下一次协议改名当场看得见,而不是变成一个只能靠截图发现的 UI 症状。
 */
const PERMISSION_PROFILE_LIST_KEYS = [
  'data',
  'permissionProfiles',
  'permission_profiles',
  'profiles',
  'items',
]

function permissionProfilesFromResponse(response) {
  if (!response || typeof response !== 'object') return []
  for (const key of PERMISSION_PROFILE_LIST_KEYS) {
    const raw = response[key]
    if (raw === undefined || raw === null) continue
    if (Array.isArray(raw)) return raw
    warnPermissionProfileShape(`local Codex permissionProfile/list carried a non-array "${key}"`, response)
    return []
  }
  warnPermissionProfileShape('local Codex permissionProfile/list carried no known profile array', response)
  return []
}

/**
 * stdout 是 ACP 协议通道,任何诊断都只能走 stderr(宿主会把它收进 stderrTail)。
 * ❌ 不抛错:档位读不到只是「切不了档」,把它升级成「会话起不动」是拿更大的故障盖小故障
 * —— 当前档仍是用户在新建会话页选定的那个,不存在静默提权。
 */
function warnPermissionProfileShape(what, response) {
  const keys = Object.keys(response).join(', ')
  process.stderr.write(`gugu codex-acp: ${what}; keys=[${keys}]\n`)
}

function appendPermissionProfiles(target, response) {
  for (const profile of permissionProfilesFromResponse(response)) {
    const id = permissionProfileId(profile)
    if (!id) continue
    const allowed = typeof profile === 'object' && profile !== null && 'allowed' in profile
      ? Boolean(profile.allowed)
      : true
    if (!allowed) continue
    target.push({
      id,
      name: permissionProfileName(profile, id),
      ...(permissionProfileDescription(profile) ? { description: permissionProfileDescription(profile) } : {}),
    })
  }
}

async function loadPermissionModes(cwd, currentProfile, timeoutMs = 45_000) {
  const selected = permissionProfileId(currentProfile)
  if (!selected) {
    process.stderr.write(
      '[codex-app-server-acp] local Codex thread/start or thread/resume did not expose an active permission profile; continuing with the provider default\n',
    )
  }
  const availableModes = []
  let cursor = null
  let safety = 0
  do {
    const response = await appRequest(
      'permissionProfile/list',
      {
        cwd,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      },
      timeoutMs
    )
    appendPermissionProfiles(availableModes, response)
    cursor = String(response?.nextCursor ?? response?.next_cursor ?? '').trim() || null
    safety += 1
    if (safety > 20) throw new Error('local Codex permissionProfile/list pagination did not terminate')
  } while (cursor)
  if (selected && !availableModes.some((mode) => mode.id === selected)) {
    availableModes.push({
      id: selected,
      name: permissionProfileName(currentProfile, selected),
      ...(permissionProfileDescription(currentProfile) ? { description: permissionProfileDescription(currentProfile) } : {}),
    })
  }
  return {
    configId: 'mode',
    selected,
    available: availableModes,
  }
}

/**
 * Permission-profile discovery only enriches the permission selector. Session lifecycle and
 * model configuration remain usable when that provider-owned introspection endpoint fails.
 */
async function probePermissionModes(cwd, currentProfile, timeoutMs = 45_000) {
  try {
    return await loadPermissionModes(cwd, currentProfile, timeoutMs)
  } catch (error) {
    process.stderr.write(
      `[codex-app-server-acp] permission profile discovery unavailable; continuing with the provider default: ${error?.message ?? error}\n`,
    )
    return null
  }
}

function withPermissionModeConfigOptions(existing, modes) {
  return modes
    ? ensurePermissionModeConfigOptions(existing, modes.selected, modes.available)
    : existing
}

function permissionModesWithRequestedProfile(modes, requestedProfile) {
  return modes && requestedProfile
    ? { ...modes, selected: requestedProfile }
    : modes
}

/**
 * 正在起的那一趟。并发调用共用它。
 *
 * ⚠️ 少了它就是**双起**:`appReady` 直到函数末尾才置真,而宿主 load 超时会重发
 * (acpSessionLifecycle 的 LOAD_RETRY_DELAYS_MS),两条 `session/load` 双双越过
 * `if (appReady) return`,各自 spawn 一个 codex app-server —— `app` / `appReader` 被后者覆盖,
 * 前一个成了孤儿进程,两边的响应还共用同一张 `appPending` 表。
 */
let appStarting = null
/** The `model_catalog_json` file handed to the current app-server; removed when this bridge exits. */
let appModelCatalog = null
process.on('exit', () => appModelCatalog?.dispose())
/**
 * This codex's own bundled catalog (`codex debug models --bundled`), read once per bridge **once it
 * succeeded**: a failed read is not remembered, so the next session start reads again instead of
 * inheriting one transient failure for the bridge's whole life. A platform session starts the read as
 * the bridge starts, so it overlaps the ACP handshake instead of adding to session/new. The error, if
 * any, surfaces where it is awaited.
 */
const bundledCatalog = memoizeSuccess(() => new Promise((resolve, reject) => {
  execFile(codexBin, ['debug', 'models', '--bundled'], {
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin),
  }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}${stderr ? `: ${String(stderr).trim()}` : ''}`))
    else resolve(stdout)
  })
}))
// @@@catalog-prefetch —— 这里只是**预热**:提前起那次 `codex debug models --bundled`,让它与 ACP 握手重叠。
// 读失败在这里吞掉是对的,因为它**没有丢**:真正的消费者 `startAppOnce` → `writeCodexModelCatalog`
// (同一个 `GUGU_PLATFORM_MODELS` 条件)会再调 `bundledCatalog()`——失败不被记住,所以那一次会重读,
// 仍失败就把它翻成用户看得见的「请升级 Codex」并让这次会话起不来;之后每次重试 `startApp` 也都会重读、再报。
// 这里挂 catch 只为不让这个**尚无人 await** 的 promise 变成 unhandled rejection(Node ≥15 会直接杀掉这座桥)。
// ❌ 但不静默:先把原因写进本桥的 stderr(宿主的适配器 stderr 日志与退出尾巴都收它)。
if (process.env.GUGU_PLATFORM_MODELS?.trim()) {
  bundledCatalog().catch((error) => {
    process.stderr.write(
      `gugu codex-acp: bundled model catalog prefetch failed (session start will report it): ${error?.message ?? error}\n`,
    )
  })
}

let sessionListRead = null

// Discovery has no session MCP credentials. Release that unbound native process before
// session setup, so listing first cannot freeze the later session's tool configuration.
async function readSessionList(params) {
  while (sessionListRead) await sessionListRead.catch(() => undefined)
  if (appStarting) await appStarting
  if (appReady) return appRequest('thread/list', params)
  const read = (async () => {
    try {
      await startAppOnce([])
      return await appRequest('thread/list', params)
    } finally {
      await appServer?.stop()
      appReader?.close()
      appServer = null
      app = null
      appReader = null
      appReady = false
      appModelCatalog?.dispose()
      appModelCatalog = null
    }
  })()
  sessionListRead = read
  try { return await read } finally { if (sessionListRead === read) sessionListRead = null }
}

async function startApp(servers) {
  // A discovery failure belongs to its caller; setup waits only for process release.
  while (sessionListRead) await sessionListRead.catch(() => undefined)
  if (appReady) return
  if (appStarting) return appStarting
  appStarting = startAppOnce(servers).finally(() => {
    // 失败要清掉:起不来是可以重试的,把一次失败钉死成「这辈子起不来」是另一个 bug。
    appStarting = null
  })
  return appStarting
}

async function startAppOnce(servers) {
  const mcp = mcpConfig(servers)
  appServerThreadConfig = mcp.config
  const reasoningSummary = process.env.GUGU_CODEX_REASONING_SUMMARY?.trim()
  if (reasoningSummary) {
    // Codex ACP is a thin bridge: argv belongs to the adapter process, while
    // `thread/start.config` is the native consumer for config.toml keys.
    // Keep the value constrained to the documented enum before forwarding it.
    if (!['auto', 'concise', 'detailed', 'none'].includes(reasoningSummary)) {
      throw new Error(`invalid GUGU_CODEX_REASONING_SUMMARY: ${reasoningSummary}`)
    }
    appServerThreadConfig.model_reasoning_summary = reasoningSummary
  }
  if (process.env.GUGU_CODEX_REASONING_SUMMARIES_SUPPORTED === 'true') {
    // Codex documents this as the explicit override for models whose catalog
    // does not advertise reasoning metadata support.
    appServerThreadConfig.model_supports_reasoning_summaries = true
  }
  if (hasGuguServer(servers)) {
    // 咕咕工具只走 MCP 这一份。首轮一定带上咕咕工具:
    // 可选 server 首次取工具只等 1 秒(codex 的 mcp_optional_startup_grace_ms),慢一步就不在那一轮里。
    // 标 required:开场等它起好,起不来就让开场响亮地失败。
    appServerThreadConfig[`mcp_servers.${GUGU_MCP_CONFIG_KEY}.required`] = true
  }
  // 哪些 server 的工具不进 code mode 的 exec 沙箱、直接上模型的工具表:声明了 alwaysLoad 的那几台(咕咕自己那台、
  // 资源库连上的服务、人选了直接列出的 App),由物化器算好递过来(session-bundle.ts codexDirectNamespaces)。
  // 咕咕自己那台在里面 —— #3551 当年挂住的那条路靠它挡住。
  const directNamespaces = process.env.GUGU_CODEX_DIRECT_TOOL_NAMESPACES?.trim()
  if (directNamespaces) {
    const parsed = JSON.parse(directNamespaces)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('GUGU_CODEX_DIRECT_TOOL_NAMESPACES must be an array of strings')
    }
    appServerThreadConfig['features.code_mode.direct_only_tool_namespaces'] = parsed
  }
  const inheritedArgs = process.argv.slice(2)
  const childEnv = { ...process.env, ...mcp.env }
  if (hasLoopbackMcp(servers)) appendNoProxy(childEnv, LOOPBACK_MCP_HOSTS)
  delete childEnv.GUGU_CODEX_BIN
  // 平台模型的 codex 元数据(#5635):宿主给的网关目录事实 → 这座桥自有的 catalog 文件,
  // 活到本进程退出。没有事实(用户自己的 Codex 账号)⇒ 不写、不加参数。
  appModelCatalog?.dispose()
  appModelCatalog = await writeCodexModelCatalog(process.env, bundledCatalog)
  if (appModelCatalog.windowUnknown.length > 0) {
    process.stderr.write(
      `gugu codex-acp: gateway directory states no context window for ${appModelCatalog.windowUnknown.join(', ')}; `
      + 'codex sizes them with its unknown-model window\n',
    )
  }
  appServer = spawnOwnedChild(codexBin, [
    'app-server',
    '--stdio',
    ...inheritedArgs,
    ...appModelCatalog.args,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    onError: (error) => rejectAppPending(error),
  })
  app = appServer.child
  app.stderr.on('data', (chunk) => process.stderr.write(chunk))
  app.on('exit', (code, signal) => {
    const error = new Error(`local Codex app-server exited (code=${code} signal=${signal})`)
    rejectAppPending(error)
    appReady = false
    if (established && !shuttingDown) process.exit(code && code !== 0 ? code : 1)
  })
  appReader = createInterface({ input: app.stdout, crlfDelay: Infinity })
  appReader.on('line', onAppLine)
  try {
    await appRequest('initialize', {
      clientInfo: { name: 'gugu', title: 'Gugu', version: '0' },
      capabilities: { experimentalApi: true },
    })
  } catch (error) {
    throw new Error(
      `本机 Codex 无法启动 app-server；请升级 Codex 后重试。原始错误：${error.message || String(error)}`,
    )
  }
  appNotify('initialized', {})
  // #6387 Installed Apps' skills: the materializer's skill root, registered before any thread so codex lists them as its
  // own. A codex that cannot is below the supported floor (0.136.0) — said loudly, not worked around.
  const skillRoots = process.env.GUGU_CODEX_SKILL_ROOTS?.trim()
  if (skillRoots) await appRequest('skills/extraRoots/set', { extraRoots: JSON.parse(skillRoots) })
  appReady = true
}

const promptInsertions = new Map()
function expectPromptInsertion(acpId, content) {
  const clientId = randomUUID()
  let resolve
  const promise = new Promise(done => { resolve = done })
  const entry = { acpId, clientId, content, promise, resolve, messageId: null, cancelled: false }
  promptInsertions.set(clientId, entry)
  return entry
}
function forgetPromptInsertion(acpId) {
  for (const [clientId, entry] of promptInsertions) if (entry.acpId === acpId) promptInsertions.delete(clientId)
}
function insertedUserMessage(item) {
  // app-server echoes the explicit clientUserMessageId as userMessage.clientId.
  // Unsolicited messages never claim an outstanding RPC, even in the same native turn.
  const entry = promptInsertions.get(item.clientId)
  sessionUpdate({ sessionUpdate: 'user_message', messageId: item.id,
    content: entry ? entry.content : [{ type: 'text', text: joinPromptText(item.content) }] })
  if (entry && !entry.cancelled) {
    entry.messageId = item.id
    entry.resolve({ messageId: item.id })
  }
}
async function receipt(id, entry) {
  const result = await entry.promise
  promptInsertions.delete(entry.clientId)
  if (result.error) throw Object.assign(new Error(result.error), { code: result.code })
  respond(id, result)
}
function throwIfInsertionCancelled(entry) {
  if (entry.cancelled) throw Object.assign(new Error('Request cancelled before insertion'), { code: -32800 })
}


function sessionUpdate(update) {
  notify('session/update', { sessionId, update })
}

const subagents = createCodexSubagents({ rootId: () => sessionId, emit: sessionUpdate, request: appRequest, itemTool, reasoningText: codexReasoningText })

/**
 * behavior `codex 的 skill 进 / 面板` —— 把用户自己放的 skill 报成 ACP slash 命令。
 *
 * # 为什么名字带 `$`
 *
 * codex 自己的 skill 调用语法就是 `$name`(官方 `learn.chatgpt.com/docs/cli/skills`:
 * “use the `$` prefix to invoke skills”),**展开发生在 codex core 里,不在这一层**。
 * 实测过(2026-09-06,codex-cli 0.144.3):把 `$gugu-token-probe` 当**普通 turn 文本**
 * 交给 `turn/start`,模型回的正是那条 skill 要求的 token —— 所以报 `$name` 不是装样子,
 * 它就是用户敲下去后真正生效的那个串。咕咕这一侧已经按「名字自带 sigil 就是原文」处理
 * (`@gugu/session-core/acp/commands` 的 `commandToken`),不会再给它多拼一个 `/`。
 *
 * # ❌ 为什么不报 codex 那 10 条内建命令
 *
 * `@agentclientprotocol/codex-acp` 报 `/review` `/plan` `/compact` 那批,是因为**它自己**
 * 在 adapter 里实现了它们(`tryHandleCommand`:改档位、调 `runCompact`、发 review turn)。
 * 这条腿一条都没实现 ⇒ 报出来的话,用户点了只会把 `/review` 当一句普通的话发给模型。
 * **那是一张骗人的菜单**,比没有更糟。要报,得先把对应的实现补上,那是另一件事。
 * 已补上的只有 `/compact`(交给 `thread/compact/start`,见 session/prompt),所以只报它。
 *
 * `enabled === false` 的不报:那是用户自己关掉的。
 */
async function publishAvailableCommands(cwd, extraRoots) {
  // ⚠️ 这个函数是被 `void` 调起来的,而进程没装 `unhandledRejection` —— 里面**任何**没接住的
  // 抛出都会带走整条 adapter,那与它自己声明的「报不出命令不该弄死会话」正好相反。
  // 所以 try 包住**整个**函数体,不只是那次 appRequest。
  // `extraRoots` 不写默认值:默认值只兜 `undefined`,`null` 照样在展开时抛。
  try {
    await publishAvailableCommandsInner(cwd, Array.isArray(extraRoots) ? extraRoots : [])
  } catch (error) {
    process.stderr.write(
      `gugu codex-acp: publishing available commands failed: ${String(error?.message ?? error)}\n`
    )
  }
}

async function publishAvailableCommandsInner(cwd, extraRoots) {
  const cwds = [cwd, ...extraRoots].filter((v) => typeof v === 'string' && v.length > 0)
  if (cwds.length === 0) return
  let response
  try {
    response = await appRequest('skills/list', { cwds })
  } catch (error) {
    // 报不出命令不该弄死一条已经建好的会话 —— 它只是少了一个入口。
    // ⚠️ 两种失败要分开,理由与上面 `model/list` 那段同源:
    //  · `-32601` = **这台 codex 没有这个方法**(旧版本)。那是常态,不是故障 ——
    //    每条会话都往 stderr 写一行只会把真信号淹掉,静默即可(面板少一组条目)。
    //  · 其它(超时 / 传输 / 形状坏)是真出事了,必须留痕,否则下次协议改名又变成
    //    只能靠截图发现的 UI 症状。
    if (error?.code !== -32601) {
      process.stderr.write(
        `gugu codex-acp: skills/list failed: ${String(error?.message ?? error)}\n`
      )
    }
    return
  }
  const seen = new Set()
  // `/compact` 是这条腿自己实现的那一条(session/prompt 里交给 `thread/compact/start`)。
  const availableCommands = [{ name: 'compact', description: 'Compact the conversation context' }]
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const raw = typeof skill?.name === 'string' ? skill.name.trim() : ''
      if (!raw || skill?.enabled === false) continue
      const name = `$${raw}`
      if (seen.has(name)) continue
      seen.add(name)
      availableCommands.push({
        name,
        description: String(skill?.shortDescription ?? skill?.description ?? raw),
      })
    }
  }
  sessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands })
}

function itemTool(item, terminalId = item?.id) {
  const type = String(item?.type ?? '')
  if (type === 'commandExecution') {
    const { type: _type, id: _id, status: _status, aggregatedOutput: _output, exitCode: _exit, durationMs, ...input } = item
    return {
      title: item.command || 'Command', kind: 'execute', rawInput: input,
      content: [{ type: 'terminal', terminalId: String(terminalId) }],
      ...(durationMs != null ? { _meta: { durationMs } } : {}),
    }
  }
  if (type === 'fileChange') {
    const content = codexFilePatches(item)
    return { title: 'Edit files', kind: 'edit', ...(content.length ? { content } : {}) }
  }
  if (type === 'mcpToolCall') {
    // The shared tool row only offers disclosure when it receives a payload. The same mapping serves live updates and
    // history replay.
    // `mcp__<server>__<tool>`: the title shape the reducer reads as an MCP call and splits into server + tool.
    // Its result's blocks (text, image, …) also as ACP `content` — MCP's content blocks are ACP's — as the Claude bridge
    // sends a tool's result: a client reads a tool's pictures there, not in the provider's own `rawOutput`.
    // And, as the Claude bridge does, the output travels once (review 10f3ea946c): a result those blocks carry whole —
    // nothing in it besides `content`, and only blocks the client reads (text, image) — is not sent again as rawOutput.
    // A failure, a result with more in it (structuredContent, isError, …), or one with a block the client does not read
    // (resource_link, resource, audio: review 3b0e55360c) keeps the provider's value.
    const blocks = Array.isArray(item.result?.content) ? item.result.content : []
    const { content: _content, ...besides } = item.result ?? {}
    const carried =
      !item.error &&
      blocks.length > 0 &&
      blocks.every((block) => block?.type === 'text' || block?.type === 'image') &&
      Object.values(besides).every((value) => value == null || value === false)
    return {
      title: `mcp__${item.server || 'mcp'}__${item.tool || 'tool'}`,
      kind: 'other',
      rawInput: item.arguments,
      rawOutput: item.error ?? (carried ? undefined : item.result) ?? undefined,
      ...(blocks.length ? { content: blocks.map((block) => ({ type: 'content', content: block })) } : {}),
    }
  }
  if (type === 'dynamicToolCall') {
    return {
      title: item.tool || 'Tool',
      kind: 'other',
      rawInput: item.arguments,
      rawOutput: item.contentItems ?? undefined,
    }
  }
  if (type === 'webSearch') {
    return { title: 'Web search', kind: 'search', rawInput: { query: item.query, action: item.action } }
  }
  if (type === 'collabAgentToolCall') {
    const { type: _type, id: _id, tool: _tool, status: _status, agentsStates, ...input } = item
    return {
      title: item.tool || 'Agent collaboration',
      kind: 'other',
      rawInput: input,
      rawOutput: agentsStates ?? undefined,
    }
  }
  return null
}

/**
 * 一整条 reasoning 条目(app-server 的 `summary` / `content` 都是纯文本数组,密文不在条目里)→ 一段思考。
 * 画哪份文本由共用判据定。整条带自己的 id,理由同下面 `replayItem` 的消息。
 */
function sendWholeReasoning(item, messageId) {
  const texts = (parts) => (Array.isArray(parts) ? parts.map(String) : [])
  const text = codexReasoningText(texts(item?.summary), texts(item?.content))
  if (text) sessionUpdate({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text } })
}

function acpToolStatus(status, fallback) {
  if (status === 'inProgress') return 'in_progress'
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'declined') return 'failed'
  return fallback
}

/**
 * 历史 item → ACP `session/update`。
 *
 * 工具条目沿用 live 的映射(`itemTool` / `acpToolStatus`)。**消息则不能照抄 live**:live 发的是
 * 一条消息的增量(deltas),宿主把没有 `messageId` 的连续增量并成同一条是对的;而历史里的每个
 * item 本身就是一条**独立**消息,不带 id 发过去会被 `foldItem` 直接字符串相加,拼成
 * `回答一回答二` 这样没有分界的一坨(实测 item-fold 的 `msg.text + event.text`)。所以每条都要带
 * 自己的 id —— 这不是与 live 不一致,这是同一个契约在「增量」与「整条」两种输入下的正确用法。
 *
 * `fallbackId` 兜住历史条目没有 id 的情况:共用空串会让多条工具调用折叠成同一个条目。
 */
function replayItem(item, fallbackId, revertAnchor) {
  if (subagents.replayItem(item)) return
  const type = String(item?.type ?? '')
  const messageId = String(item?.id ?? '') || fallbackId
  if (type === 'userMessage') {
    // live 从不回声用户消息(客户端自己就有);重放时客户端手里是空的,这条只能由适配器补。
    // 复用 textPrompt:多段文本的连接方式必须和发送侧一致,否则重放出来的话和当初发出去的不一样。
    const text = joinPromptText(item?.content)
    if (text) sessionUpdate({ sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text }], ...(revertAnchor ? { _meta: { guguRevertAnchor: revertAnchor } } : {}) })
    return
  }
  if (type === 'agentMessage') {
    if (item.text) {
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: String(item.text) },
      })
    }
    return
  }
  if (type === 'reasoning') {
    sendWholeReasoning(item, messageId)
    return
  }
  const terminal = codexTerminalUpdate(item, messageId, true)
  if (terminal) sessionUpdate(terminal)
  const tool = itemTool(item, messageId)
  if (!tool) return
  // 历史只有终态,没有 `item/started` 那一拍。因此发 `tool_call`(建条目)而不是 `tool_call_update`
  // (改条目)—— 后者会是一条没有母体的更新。
  sessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: messageId,
    status: acpToolStatus(item.status, 'completed'),
    name: item.type,
    ...tool,
  })
}

/**
 * 新线程一律按 `paginated` 建。
 *
 * codex 的线程有两种历史模式,`thread/start` 的 `historyMode` 取 `legacy | paginated`,不传就是
 * `legacy`。这个默认值决定了**以后还能不能把这段对话读回来**:
 *  - `legacy`:`thread/turns/list` 走有损投影,只剩消息和 fileChange —— 执行过的命令读不出来
 *    (实测:某条线程 rollout 里存着 10 次 exec,该接口一次都不给);`thread/items/list` 直接
 *    报 `not supported yet`(源码里那句来自 `ThreadStoreError::Unsupported`,是**存储后端**说的,
 *    不是方法没实现)。
 *  - `paginated`:两个接口都给全量条目,含 `commandExecution` 和命令原文。
 *
 * 也就是说「重开会话看不到当初跑过的命令」不是 codex 的限制,是这里没选对模式。已实测 `thread/fork`
 * (会话页在用)在 paginated 线程上正常。
 */
const THREAD_HISTORY_MODE = 'paginated'

/** 一页最多取多少轮;`thread/turns/list` 实测按此分页。 */
const REPLAY_PAGE_LIMIT = 100
/** 翻页硬上限 —— 只防跑飞(比如上游一直给 cursor 却不给数据),真正的成本闸是下面的条目数。 */
const REPLAY_MAX_PAGES = 20
/**
 * 重放条目总数上限。
 *
 * 成本变量是**条目数**不是页数:宿主 reducer 每收一条事件都要走一遍整个 transcript
 * (`assertTranscriptInvariants`),条目多了是平方级。按页设闸会让「20 页 × 100 轮 × 每轮几条」
 * 这种长会话把主进程顶住。
 */
const REPLAY_MAX_ITEMS = 2_000
/**
 * 历史本身的时间上限:即便 load 开头很快,也不该为历史无限等下去。
 */
const REPLAY_BUDGET_MS = 15_000
/**
 * 整个 `session/load` 的软预算。
 *
 * 宿主给单次 load 的硬预算是 40s(acp-host 的 `LOAD_ATTEMPT_TIMEOUT_MS`),超了会重试、再降级
 * `session/new` —— 上下文**真的**就丢了,比没有历史坏得多。所以历史的截止时刻要从 load 起点算,
 * 把 `thread/resume` 已经花掉的时间扣掉,并给后面的权限档读取留出余量。只按「进函数时 +15s」算,
 * 等于假装 resume 不花时间。
 */
const SESSION_LOAD_SOFT_BUDGET_MS = 30_000

/**
 * 取整条 thread 的历史轮次。返回顺序原样保留 codex 的**新→旧**。
 *
 * 三条性质都是对 codex-cli 0.146.0 实测出来的,不是推的:
 *  - `data` 新→旧,`nextCursor` 继续往更旧翻 ⇒ 各页首尾相接仍是新→旧;
 *  - 默认 `itemsView` 是 `summary`,会把中间的 commentary 消息折掉只留 final_answer ⇒ 必须要 `full`;
 *  - 未加载的 thread 直接报 `thread not loaded` ⇒ 只能在 `thread/resume` 之后调。
 *
 * 中途出错/到点只**收手**,不把已经拿到的页一起扔掉:codex 是新→旧发,手里那些正是最近的几轮,
 * 也正是截断时最该保住的一头。一页都没拿到才上抛,交给上层记「跳过重放」。
 */
/**
 * 建线程,优先 paginated,不支持就退回默认。
 *
 * 退回而不是报错:历史少一截总好过整个会话开不起来。哪些 codex 支持,不该由我们在这里猜版本 ——
 * 问一次,它自己会说(不支持时 `thread/start` 回 `paginated threads require ...`)。
 */
async function startThread(base) {
  try {
    return await appRequest('thread/start', { ...base, historyMode: THREAD_HISTORY_MODE })
  } catch (error) {
    process.stderr.write(
      `[codex-app-server-acp] ${THREAD_HISTORY_MODE} history unavailable, new thread falls back to legacy `
      + `(执行过的命令将无法重放): ${error.message || String(error)}\n`,
    )
    return appRequest('thread/start', base)
  }
}

async function loadThreadTurns(threadId, deadline) {
  const turns = []
  let items = 0
  let cursor = null
  for (let page = 0; page < REPLAY_MAX_PAGES; page += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return { turns, truncated: 'budget' }
    let result
    try {
      result = await appRequest('thread/turns/list', {
        threadId,
        limit: REPLAY_PAGE_LIMIT,
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      }, remainingMs)
    } catch (error) {
      if (turns.length === 0) throw error
      process.stderr.write(
        `[codex-app-server-acp] history page ${page + 1} failed, replaying the ${turns.length} turns already fetched: ${error.message || String(error)}\n`,
      )
      return { turns, truncated: 'error' }
    }
    for (const turn of Array.isArray(result?.data) ? result.data : []) {
      turns.push(turn)
      items += Array.isArray(turn?.items) ? turn.items.length : 0
    }
    // 与 loadPermissionModes 同一套归一化:上游哪天回 snake_case,分页不该只在这里悄悄停在第一页。
    cursor = String(result?.nextCursor ?? result?.next_cursor ?? '').trim() || null
    if (!cursor) return { turns, truncated: null }
    // 空页 + 还有 cursor ≠ 读完了。当年那版把它当读完,会把更旧的历史无声丢掉。
    if (items >= REPLAY_MAX_ITEMS) return { turns, truncated: 'items' }
  }
  return { turns, truncated: 'pages' }
}

/**
 * `session/load` 的历史重放。
 *
 * ACP 里 load 的语义是「把这条会话已有的对话经 `session/update` 流回客户端」—— 客户端自己不留
 * transcript,重放是它重建对话的唯一来源。少了这一步,重开旧会话拿到的是零条消息,界面于是渲染
 * 「新会话空态」而不是「会话丢了」:比丢失更糟,因为它连这儿本该有东西都不知道。
 *
 * 拿不到历史只降级成「没有历史」,绝不让 `session/load` 失败 —— 会话能用比历史完整更要紧。
 *
 * `generation` 防的是宿主的重试:load 超时后它会隔 1s 再发一次(`LOAD_RETRY_DELAYS_MS`),而适配器
 * 对 ACP 请求不做串行化。没有这道闸,两次重放会交错写同一条会话,transcript 直接重影。
 */
async function replayHistory(threadId, generation, deadline) {
  let loaded
  try {
    loaded = await loadThreadTurns(threadId, deadline)
  } catch (error) {
    process.stderr.write(
      `[codex-app-server-acp] history replay skipped, session loads without it: ${error.message || String(error)}\n`,
    )
    return
  }
  if (loaded.truncated) {
    // 出声,别静默裁剪:少了的那截历史看上去和「本来就没有」一模一样。
    process.stderr.write(
      `[codex-app-server-acp] history replay stopped by ${loaded.truncated} cap at ${loaded.turns.length} turns; older turns are NOT replayed\n`,
    )
  }
  if (generation !== loadGeneration) return
  // codex 给的是新→旧,对话顺序要旧→新。照数组原样重放会把整段对话倒过来。
  for (let i = loaded.turns.length - 1; i >= 0; i -= 1) {
    const turn = loaded.turns[i]
    const items = Array.isArray(turn?.items) ? turn.items : []
    let userSeen = false
    for (let j = 0; j < items.length; j += 1) {
      // 每轮之间再查一次:重放一条长会话要写几千行,期间宿主完全可能已经重来一次 load。
      if (generation !== loadGeneration) return
      // A native turn may also contain steered inputs; only its leading prompt is a turn boundary.
      replayItem(items[j], `${String(turn?.id ?? `turn-${i}`)}:${j}`, historyCanRevert && !userSeen ? turn.id : undefined)
      if (items[j]?.type === 'userMessage') userSeen = true
    }
  }
  await subagents.replayChildren(deadline)
}

/**
 * 上下文占用(composer 右下角那个圆环)。
 *
 * codex app-server 用 `thread/tokenUsage/updated` 报 `tokenUsage.{last,total,modelContextWindow}`,
 * 上游 `@agentclientprotocol/codex-acp` 就是拿它拼 ACP 的 `usage_update`。这座桥从前**整个没监听
 * 这个通知**,于是 codex 会话一条 `usage_update` 也发不出去,圆环没有数据、压根不渲染
 * (宿主的闸是 `contextUsage && contextUsage.size > 0`)。
 * 与模型/推理档是同一类漏接:上游接了,自建这座没接。
 *
 * ⚠️ `used` 取 **last**(这一轮结束时线程里有多少 token),❌ 不是 `total`。
 *    `total` 是整条会话累计消耗,会一路涨到远超窗口 —— 拿它当占用,圆环第二轮就爆表。
 * ⚠️ 窗口读不到就**不发**:ACP 文档明写「agent 给不出有意义的 context window size 时不应发送
 *    usage_update」。发一条 size=0 反而会让宿主渲染出一个恒 0% 的圆环 —— 那比不显示更糟,
 *    它看起来像「测到了,就是没用」。
 */
let warnedUnusableTokenUsage = false

function emitUsageUpdate(params) {
  const usage = params?.tokenUsage
  if (!usage || typeof usage !== 'object') return warnUnusableTokenUsage('no tokenUsage object', params)
  // The declared window belongs to this session and outranks Codex's fallback model metadata.
  // Keep the provider value for BYOK/unknown declarations, where it is the only measured source.
  const size = declaredContextWindow ?? Number(usage.modelContextWindow)
  const used = Number(usage.last?.totalTokens)
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(used) || used < 0) {
    return warnUnusableTokenUsage('unusable modelContextWindow or last.totalTokens', params)
  }
  sessionUpdate({ sessionUpdate: 'usage_update', used, size })
}

/**
 * 通知来了却读不出数 —— 每进程只喊一次。
 *
 * ⚠️ 少了这句,codex 哪天把字段改个名(camelCase→snake_case 这类,本文件的
 * `nextCursor` / `next_cursor` 就真的两种都遇到过),这里会**静默不发**,圆环无声消失,
 * 只能靠用户截图发现 —— 与权限档目录、模型目录当年那两个坑同形,那两处已立过规矩。
 * ❌ 反过来也不能凭空加一堆没在真机见过的字段兜底:那是拿想象的形状冒充测量。
 *    真机(app-server 0.149.1)给的就是 camelCase 的 `modelContextWindow` / `last.totalTokens`。
 */
function warnUnusableTokenUsage(why, params) {
  if (warnedUnusableTokenUsage) return
  warnedUnusableTokenUsage = true
  const keys = Object.keys(params?.tokenUsage ?? params ?? {}).join(', ')
  process.stderr.write(
    `gugu codex-acp: thread/tokenUsage/updated ${why}; keys=[${keys}] —— 上下文占用圆环将不显示\n`
  )
}

function onAppNotification(message) {
  const method = String(message.method ?? '')
  const params = message.params ?? {}
  if (subagents.onNotification(message)) return
  // app-server also publishes spawned agents' events. Only this thread owns the ACP session;
  // mixing child deltas here fragments messages/thinking and can overwrite the parent's state.
  if (params.threadId && params.threadId !== sessionId) return
  if (method === 'thread/tokenUsage/updated') {
    emitUsageUpdate(params)
    return
  }
  if (method === 'thread/settings/updated') {
    const profile = permissionProfileId(
      params.permissions ?? params.permissionProfile ?? params.activePermissionProfile,
    )
    if (!profile) {
      process.stderr.write(
        `[codex-app-server-acp] thread/settings/updated carried no permission profile; keys=[${Object.keys(params).join(', ')}]\n`,
      )
      return
    }
    selectedPermissionProfile = profile
    void (async () => {
      const modes = await probePermissionModes(null, selectedPermissionProfile)
      sessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: withModelConfigOptions(
          withPermissionModeConfigOptions(null, modes),
          selectedModel,
          selectedEffort,
          await modelCatalogOnce(),
        ),
      })
    })().catch((error) => {
      process.stderr.write(
        `[codex-app-server-acp] failed to publish thread/settings/updated: ${error?.message ?? error}\n`,
      )
    })
    return
  }
  if (method === 'item/agentMessage/delta') {
    streamedItems.set(String(params.itemId ?? ''), 0)
    sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: String(params.itemId),
      content: { type: 'text', text: String(params.delta ?? '') },
    })
    return
  }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    // 一段思考分几节(摘要每节以加粗小标题开头),增量各带节号;换节时空一行,与整条补发同一个拼法(codexReasoningText)。
    const itemId = String(params.itemId ?? '')
    const part = params.summaryIndex ?? params.contentIndex ?? 0
    const previous = streamedItems.get(itemId)
    streamedItems.set(itemId, part)
    sessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      messageId: String(params.itemId),
      content: { type: 'text', text: `${previous !== undefined && previous !== part ? '\n\n' : ''}${String(params.delta ?? '')}` },
    })
    return
  }
  if (method === 'item/commandExecution/outputDelta') {
    sessionUpdate({ sessionUpdate: 'terminal_output_chunk', terminalId: String(params.itemId), data: Buffer.from(String(params.delta ?? ''), 'utf8').toString('base64') })
    return
  }
  if (method === 'item/plan/delta') {
    sessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      messageId: String(params.itemId),
      content: { type: 'text', text: String(params.delta ?? '') },
    })
    return
  }
  if (method === 'item/started') {
    if (params.item?.type === 'userMessage') { insertedUserMessage(params.item); return }
    trackRunningCommand(params, 'started')
    if (params.item?.type === 'contextCompaction') return compactionUpdate(params.item, 'in_progress')
    const terminal = codexTerminalUpdate(params.item ?? {})
    if (terminal) sessionUpdate(terminal)
    const tool = itemTool(params.item)
    if (tool) {
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: String(params.item?.id ?? ''),
        status: acpToolStatus(params.item?.status, 'in_progress'),
        name: params.item.type,
        ...tool,
      })
    }
    return
  }
  if (method === 'item/completed') {
    trackRunningCommand(params, 'completed')
    const item = params.item ?? {}
    if (item.type === 'contextCompaction') return compactionUpdate(item, 'completed')
    const outcome = guguToolOutcome(item)
    if (outcome) recordGuguToolOutcome(outcome.tool, { ...params, itemId: item.id }, outcome.success, outcome.cause)
    const streamed = streamedItems.has(String(item.id ?? ''))
    if (item.type === 'agentMessage' && item.text && !streamed) {
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: String(item.id),
        content: { type: 'text', text: String(item.text) },
      })
    }
    if (item.type === 'reasoning' && !streamed) sendWholeReasoning(item, String(item.id ?? ''))
    const terminal = codexTerminalUpdate(item, item.id, true)
    if (terminal) sessionUpdate(terminal)
    const tool = itemTool(item)
    if (tool) {
      sessionUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: String(item.id ?? ''),
        status: outcome?.success === false ? 'failed' : acpToolStatus(item.status, 'completed'),
        name: item.type,
        ...tool,
      })
    }
    return
  }
  if (method === 'turn/started') {
    beginCycle(String(params.turn.id))
    sessionUpdate({ sessionUpdate: 'state_update', state: 'running' })
    if (compactInsertion !== null) {
      const entry = compactInsertion
      compactInsertion = null
      if (!entry.cancelled) insertedUserMessage({ id: `compact:${params.turn.id}`, clientId: entry.clientId })
    }
    return
  }
  if (method === 'turn/completed') {
    for (const [toolCallId, command] of runningCommands) {
      if (command.turnId !== params.turn?.id) continue
      command.turnId = null
      sessionUpdate({
        sessionUpdate: 'async_task_spawned', asyncTaskId: command.processId, toolCallId,
        name: command.name, description: command.name, taskType: 'Bash', showInTranscript: true, canStop: true,
      })
    }
    if (!activeCycle || activeCycle.turnId === String(params.turn?.id)) {
      sessionUpdate({ sessionUpdate: 'state_update', state: 'idle', ...turnOutcome(params.turn) })
    }
    settleCycle(params.turn)

  }
}

function trackRunningCommand(params, edge) {
  const item = params.item ?? {}
  const turnId = String(params.turnId ?? '')
  if (item.type !== 'commandExecution' || !turnId || !item.id) return
  const toolCallId = String(item.id)
  if (edge === 'started' && item.processId) {
    runningCommands.set(toolCallId, { turnId, processId: String(item.processId), name: item.command || 'Command' })
  } else if (edge === 'completed') {
    const command = runningCommands.get(toolCallId)
    runningCommands.delete(toolCallId)
    if (command?.turnId === null) sessionUpdate({
      sessionUpdate: 'async_task_state_update', asyncTaskId: command.processId, toolCallId,
      state: acpToolStatus(item.status, 'completed'),
    })
  }
}

async function terminateCommand(processId) {
  const result = await appRequest('thread/backgroundTerminals/terminate', { threadId: sessionId, processId })
  return { stopped: result?.terminated === true }
}

// Snapshot this turn before interrupt publishes its end; older background tasks stay owned by the host.
async function cancelTurn(turnId) {
  const commands = [...runningCommands.values()].filter((command) => command.turnId === turnId)
  await appRequest('turn/interrupt', { threadId: sessionId, turnId })
  await Promise.all(commands.map((command) => terminateCommand(command.processId)))
}

/**
 * codex 的压缩条目(`/compact` 与自动压缩同一个,`core/src/compact.rs` 的 ContextCompaction)→
 * ACP `compaction_update`:宿主画「上下文已压缩」那道分隔线(decode.ts 同名分支)。
 */
function compactionUpdate(item, status) {
  if (!item.id) return
  sessionUpdate({ sessionUpdate: 'compaction_update', compactionId: String(item.id), status })
}

/** Native foreground has one owner; prompt receipts do not participate in its completion. */
function beginCycle(turnId) {
  if (activeCycle?.turnId === turnId) return
  let resolveCompletion
  const completion = new Promise(resolve => { resolveCompletion = resolve })
  activeCycle = { turnId, completion, resolveCompletion }
}
function settleCycle(turn) {
  const turnId = String(turn?.id ?? '')
  toolOutcomesByTurn.delete(turnId)
  if (activeCycle?.turnId !== turnId) return
  const cycle = activeCycle
  activeCycle = null
  cycle.resolveCompletion()
}

function turnOutcome(turn) {
  const status = String(turn?.status ?? 'completed')
  const failure = toolOutcomesByTurn.get(String(turn?.id ?? ''))?.failure
  const _meta = historyCanRevert ? { guguRevert: { before: String(turn.id) } } : undefined
  if (status === 'interrupted') return { stopReason: 'cancelled', ...(_meta ? { _meta } : {}) }
  if (status === 'completed' && !failure) return { stopReason: 'end_turn', ...(_meta ? { _meta } : {}) }
  return { stopReason: 'error', error: { code: -32603,
    message: status === 'failed' ? String(turn?.error?.message ?? 'local Codex turn failed')
      : failure ? `local Codex turn had a failed Gugu tool call: ${failure.tool} (${failure.itemId}): ${failure.details}`
      : `unexpected local Codex turn status: ${status}`,
    data: turn?.error ?? failure ?? null } }
}

function activeTurnIdFromThread(value) {
  const record = value?.thread && typeof value.thread === 'object' ? value.thread : value
  const turns = record?.turns
  if (!Array.isArray(turns)) return null
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    if (turn?.status === 'inProgress' && turn.id) return String(turn.id)
  }
  return null
}

function guguToolOutcome(item) {
  const tool = normalizeGuguToolName(item?.tool)
  if (item?.type === 'mcpToolCall' && item.server === GUGU_MCP_CONFIG_KEY) {
    return {
      tool,
      success: item.status === 'completed' && !item.error && item.result?.isError !== true,
      cause: item.error ?? item.result ?? { status: item.status },
    }
  }
  return null
}

function recordGuguToolOutcome(tool, params, success, cause) {
  // Only the reply tool decides the turn: a turn whose reply was rejected must not settle as
  // answered (#4052). Any other Gugu tool error — a bad argument, an extension tool reached
  // through catalog_call — is an ordinary tool result the model already sees and can correct,
  // same as a tool on any other MCP server (#6628).
  if (tool !== 'message_send') return
  const turnId = String(params?.turnId ?? '')
  const itemId = String(params?.itemId ?? '')
  // Never infer turn ownership from whichever ACP prompt happens to be active.
  if (!turnId || !itemId || (params?.threadId && params.threadId !== sessionId)) return
  const outcomes = toolOutcomesByTurn.get(turnId) ?? { seen: new Set(), failure: null }
  if (outcomes.seen.has(itemId)) return
  outcomes.seen.add(itemId)
  if (!success) {
    const content = Array.isArray(cause) ? cause : cause?.content
    const details = cause?.message
      ?? (Array.isArray(content) ? content.map((item) => item?.text ?? '').filter(Boolean).join('\n') : '')
    // The shared SerializedError boundary keeps scalar data only. Encode the
    // original cause losslessly so it survives into the persisted turn detail.
    outcomes.failure = { tool, turnId, itemId, cause: JSON.stringify(cause), details: details || JSON.stringify(cause) }
  } else {
    // Only a later, distinct successful reply recovers an earlier failure (#4052).
    outcomes.failure = null
  }
  toolOutcomesByTurn.set(turnId, outcomes)
}

// `item/tool/requestUserInput` —— **向人提问**,不是权限闸。
//
// 之前这里拿 `/\b(allow|approve|yes|continue|use|run)\b/i` 去匹配选项文案,命中就选它、
// 一个都不命中就取 `options[0]`,再把 label 当成**用户的回答**发回 codex。一道内容型问题
// (「这三个方案选哪个」)上那串许可类词一个都不会命中 => 恒定落到 `options[0]`,一个与问题
// 无关的任选项被冒充成用户表态。踩的是本仓 fail-loud / ❌fake 铁律。
//
// 判据(owner 2026-08-24 定):**允许停下来等人,前提是这一问渲染得出来** —— 渲染不出来的
// 话,人看不见也就无从说继续,那时唯一诚实的回答是「没有答案」。
//
// 渲染得出来的形状只有一种(`permission-band.tsx:30-44`:`options[] + onResolve(optionId)`,
// 单选、一次一条):
//   · `isBlocking` 且 options 非空 且非密文 -> 真的问人,等他点。
//   · 其余(自由文本 / 密文 / 非阻塞)        -> 如实回 `answers: []`。
//
// ⚠️ 空答案是**协议里的正常回包**,不是错误路径 —— 上游把回包直接
//    `serde_json::to_string(&response)` 交给模型当 tool output,不校验、没有错误分支
//    (`core/src/tools/handlers/request_user_input.rs`),而上游自己的测试就用
//    `ToolRequestUserInputResponse { answers: HashMap::new() }`
//    (`tui/src/app/app_server_requests.rs:1002`)。参考客户端 TUI 的真实路径同样是
//    **排队等人、从不代答**(`:145` 入队,`:391` 出队)。基准 sha
//    openai/codex@a25e986323931ec54909b0cd936b612f30c8ce46。
//
// ⚠️ `isBlocking` 不是咕咕要定的策略,codex 逐请求带着它。两条来源都已核实:
//    · `request_user_input` 工具(模型主动问人)-> `is_blocking: mode == ModeKind::Plan`;
//    · **MCP 工具授权**(`core/src/mcp_tool_call.rs:1504`)-> 恒 `is_blocking: true`。
//    后一条要紧:codex **只在用户配置的授权档要求时才发这一问**
//    (`:2225-2230`,`AppToolApproval::Approve => false` 就是不问)。影响面是有界的:
//    默认档是 `Auto`(`config/src/mcp_types.rs:23-31` 的 `#[default]`),而
//    `Auto => requires_mcp_tool_approval(annotations)` —— 只对 MCP server **自己标注了
//    需要授权**的工具才问,不是每次 MCP 调用都弹。咕咕自己交出的 server 在 `mcpConfig` 里
//    按 server 设了 `default_tools_approval_mode = approve`,也不经这一问。所以从前那句无脑
//    「Allow」不是「自治」,是**悄悄压过用户自己在 `~/.codex/config.toml` 里按 server 设的档**
//    —— 与本文件其它注释说的「档位单一来源」「选择框成了摆设」是同一类病。
//    ❌ 别在这里加一条全局开关去覆盖它。
//
// ⚠️ 密文(`isSecret`)这一支**故意不接**:permission-band 没有输入框,而且
//    `session-runtime/.../session/cell.ts:330` 会把整个请求原样落 rawLog ——
//    接自由文本密文之前必须先掐掉那条记录,否则用户敲的 token 会进日志。
function questionIsRenderable(question, isBlocking) {
  if (!isBlocking) return false
  if (question?.isSecret === true) return false
  return Array.isArray(question?.options) && question.options.length > 0
}

function questionTitle(question) {
  const header = String(question?.header ?? '').trim()
  const body = String(question?.question ?? '').trim()
  if (header && body && header !== body) return `${header} — ${body}`
  return body || header || 'Agent 有一个问题'
}

async function askHuman(itemId, question) {
  const options = question.options
  // Codex user-input options have no stable ids; use their position for this one request and
  // return the selected label exactly. Approval requests below use provider decisions instead.
  const picked = await askHumanChoice(itemId, questionTitle(question), options.map((option, index) => ({
    optionId: String(index),
    name: String(option?.label ?? '').trim() || `选项 ${index + 1}`,
    kind: 'other',
    value: option,
  })), question.id)
  if (!picked) return []
  const label = String(picked.value?.label ?? '').trim()
  return label ? [label] : []
}

/**
 * Send one blocking request to the shared permission band and return the exact selected value.
 * The band owns the decision; this bridge only carries the provider's option ids and values.
 */
async function askHumanChoice(
  itemId,
  title,
  options,
  requestKey = options[0]?.optionId ?? 'choice',
  { requireSelection = false, rawInput, subjectToolCall } = {},
) {
  if (options.length === 0) return null
  const outcome = await acpRequest('session/request_permission', {
    sessionId,
    title,
    subject: { type: 'tool_call', toolCall: subjectToolCall ?? { toolCallId: `${itemId}:ask:${requestKey}`, title, ...(rawInput !== undefined ? { rawInput } : {}) } },
    options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
  })
  if (outcome?.outcome?.outcome !== 'selected') {
    if (requireSelection) {
      throw new Error(`ACP host did not return a selected permission option (${outcome?.outcome?.outcome ?? 'unknown outcome'})`)
    }
    return null
  }
  const optionId = String(outcome.outcome.optionId ?? '')
  const selected = options.find((option) => option.optionId === optionId)
  if (!selected) throw new Error(`ACP host selected unknown permission option '${optionId}'`)
  return selected
}

function approvalDecisionKey(decision) {
  if (typeof decision === 'string') return decision
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return ''
  return Object.keys(decision)[0] ?? ''
}

function approvalDecisionKind(decision) {
  const key = approvalDecisionKey(decision)
  if (key === 'accept') return 'allow_once'
  if (
    key === 'acceptForSession' ||
    key === 'acceptWithExecpolicyAmendment' ||
    key === 'applyNetworkPolicyAmendment'
  ) return 'allow_always'
  if (key === 'decline' || key === 'cancel') return 'reject_once'
  return 'other'
}

function approvalDecisionName(decision) {
  const key = approvalDecisionKey(decision)
  switch (key) {
    case 'accept':
      return 'Allow once'
    case 'acceptForSession':
      return 'Allow for this session'
    case 'acceptWithExecpolicyAmendment':
      return "Allow and don't ask again for matching commands"
    case 'applyNetworkPolicyAmendment':
      return decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === 'deny'
        ? 'Block this host in the future'
        : 'Allow this host in the future'
    case 'decline':
      return 'Reject'
    case 'cancel':
      return 'Cancel'
    default:
      return key || 'Provider decision'
  }
}

function legacyCommandApprovalDecisions(params) {
  // Codex added availableDecisions after the original request shape. Keep this fallback aligned
  // with its source-level default set while using decline for the user-facing rejection path.
  if (params?.networkApprovalContext) {
    const decisions = ['accept', 'acceptForSession']
    const amendment = params.proposedNetworkPolicyAmendments?.find(
      (item) => item?.action === 'allow',
    )
    if (amendment) decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } })
    decisions.push('decline')
    return decisions
  }
  if (params?.additionalPermissions) return ['accept', 'decline']
  const decisions = ['accept']
  if (params?.proposedExecpolicyAmendment) {
    decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } })
  }
  decisions.push('decline')
  return decisions
}

function approvalChoices(method, params) {
  let decisions
  if (Array.isArray(params?.availableDecisions)) {
    decisions = params.availableDecisions
  } else if (method === 'item/fileChange/requestApproval') {
    decisions = ['accept', 'acceptForSession', 'decline']
  } else {
    decisions = legacyCommandApprovalDecisions(params)
  }
  return decisions.map((decision, index) => ({
    optionId: `codex-decision-${index}`,
    name: approvalDecisionName(decision),
    kind: approvalDecisionKind(decision),
    value: decision,
  }))
}

function commandApprovalTitle(params) {
  const command = String(params?.command ?? '').trim()
  if (command) return command
  const context = params?.networkApprovalContext
  if (context?.host) return `${String(context.protocol ?? 'network').toUpperCase()} ${context.host}`
  return String(params?.reason ?? '').trim() || 'Command execution'
}

function fileApprovalTitle(params) {
  const root = String(params?.grantRoot ?? '').trim()
  if (root) return `Write files under ${root}`
  return String(params?.reason ?? '').trim() || 'Apply file changes'
}

function permissionSummary(permissions) {
  const parts = []
  if (permissions?.network?.enabled === true) parts.push('network access')
  const fileSystem = permissions?.fileSystem
  for (const mode of ['read', 'write']) {
    const paths = Array.isArray(fileSystem?.[mode]) ? fileSystem[mode] : []
    if (paths.length > 0) parts.push(`${mode} ${paths.join(', ')}`)
  }
  return parts.join('; ') || 'the requested permissions'
}

function permissionApprovalTitle(params) {
  const reason = String(params?.reason ?? '').trim()
  const summary = permissionSummary(params?.permissions)
  return reason ? `${reason} (${summary})` : `Grant ${summary}`
}

function permissionChoices() {
  return [
    { optionId: 'codex-permission-turn', name: 'Allow for this turn', kind: 'allow_once', value: 'turn' },
    { optionId: 'codex-permission-session', name: 'Allow for this session', kind: 'allow_always', value: 'session' },
    { optionId: 'codex-permission-deny', name: 'Reject', kind: 'reject_once', value: 'deny' },
  ]
}

function deniedPermissionResult() {
  return { permissions: {}, scope: 'turn', strictAutoReview: false }
}

function approvalRequestDiagnostic(method, itemId, params, error) {
  let paramsSummary
  try {
    paramsSummary = JSON.stringify(params)
  } catch {
    paramsSummary = '<params could not be serialized>'
  }
  if (paramsSummary.length > 2_000) paramsSummary = `${paramsSummary.slice(0, 2_000)}...`
  const reason = String(error?.message ?? error ?? 'unknown approval failure')
  return `[Gugu] ${method} approval could not be delivered (item ${itemId}); params=${paramsSummary}; error=${reason}`
}

function failApprovalLoud(message, method, itemId, params, error) {
  const diagnostic = approvalRequestDiagnostic(method, itemId, params, error)
  let paramsSummary
  try {
    paramsSummary = JSON.stringify(params)
  } catch {
    paramsSummary = '<params could not be serialized>'
  }
  if (paramsSummary.length > 2_000) paramsSummary = `${paramsSummary.slice(0, 2_000)}...`
  process.stderr.write(`[codex-app-server-acp] ${diagnostic}\n`)
  try {
    if (sessionId) {
      sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: `approval-error:${itemId}`,
        content: { type: 'text', text: diagnostic },
      })
    }
  } catch (notifyError) {
    process.stderr.write(
      `[codex-app-server-acp] approval failure notification failed: ${notifyError?.message ?? notifyError}\n`,
    )
  }
  try {
    appWrite({
      id: message.id,
      error: {
        code: -32603,
        message: diagnostic,
        data: { method, itemId, paramsSummary },
      },
    })
  } catch (responseError) {
    process.stderr.write(
      `[codex-app-server-acp] ${method} error response ${itemId} failed: ${responseError?.message ?? responseError}\n`,
    )
  }
}

function guguMcpToolElicitationCanAutoAccept(params) {
  if (String(params?.serverName ?? '') !== GUGU_MCP_CONFIG_KEY) return false
  if (!isMcpToolCallApproval(params)) return false
  return mcpElicitationHasEmptyObjectSchema(params)
}

function mcpElicitationHasEmptyObjectSchema(params) {
  const schema = params?.requestedSchema
  const properties = schema?.properties
  return schema?.type === 'object'
    && properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && Object.keys(properties).length === 0
}

function mcpElicitationCanUseApprovalBand(params) {
  const schema = params?.requestedSchema
  return schema == null || mcpElicitationHasEmptyObjectSchema(params)
}

function jsonSummary(value, maxLength = 1_200) {
  let summary
  try {
    summary = JSON.stringify(value)
  } catch {
    summary = '<could not serialize>'
  }
  if (!summary) summary = '<none>'
  return summary.length > maxLength ? `${summary.slice(0, maxLength)}...` : summary
}

function mcpElicitationToolName(params) {
  const explicit = [
    params?.toolName,
    params?.tool,
    params?._meta?.tool_name,
    params?._meta?.toolName,
  ].find((value) => typeof value === 'string' && value.trim())
  if (explicit) return explicit.trim()
  const message = String(params?.message ?? '')
  const match = message.match(/\btool\s+["'`]([^"'`]+)["'`]/i)
  return match?.[1]?.trim() || 'MCP tool'
}

function mcpElicitationToolParams(params) {
  return params?._meta?.tool_params ?? params?.tool_params ?? params?.toolParams ?? {}
}

function isMcpToolCallApproval(params) {
  return params?._meta?.codex_approval_kind === 'mcp_tool_call'
}

function mcpElicitationTitle(params) {
  const server = String(params?.serverName ?? '').trim() || 'unknown server'
  const tool = mcpElicitationToolName(params)
  // A tool-call approval carries no item id, so it is named the way `itemTool` names its row; its parameters ride as rawInput.
  if (isMcpToolCallApproval(params)) return `mcp__${server}__${tool}`
  const message = String(params?.message ?? '').trim()
  const parts = [`MCP request from ${server}: ${tool}`]
  if (message) parts.push(message)
  parts.push(`Parameters: ${jsonSummary(mcpElicitationToolParams(params))}`)
  return parts.join(' | ')
}

function mcpElicitationActions(params) {
  const supplied = params?.choices ?? params?.availableChoices ?? params?._meta?.choices
  if (Array.isArray(supplied)) {
    const actions = supplied
      .map((choice) => typeof choice === 'string' ? choice : choice?.action ?? choice?.value)
      .filter((action) => action === 'accept' || action === 'decline' || action === 'cancel')
    if (actions.length > 0) return [...new Set(actions)]
  }
  // The app-server elicitation response contract supplies these three actions when the
  // request does not carry a narrower choice set.
  return ['accept', 'decline', 'cancel']
}

function mcpElicitationChoices(params) {
  return mcpElicitationActions(params).map((action, index) => ({
    optionId: `codex-mcp-action-${index}`,
    name: action === 'accept' ? 'Allow' : action === 'decline' ? 'Reject' : 'Cancel',
    kind: action === 'accept' ? 'allow_once' : 'reject_once',
    value: action,
  }))
}

async function answerMcpElicitation(message) {
  const params = message.params ?? {}
  if (guguMcpToolElicitationCanAutoAccept(params)) {
    appWrite({ id: message.id, result: { action: 'accept', content: {} } })
    return
  }
  const itemId = String(params.itemId ?? message.id)
  try {
    if (!mcpElicitationCanUseApprovalBand(params)) {
      throw new Error('MCP elicitation schema requires fields that the permission band cannot render')
    }
    const selected = await askHumanChoice(
      itemId,
      mcpElicitationTitle(params),
      mcpElicitationChoices(params),
      `mcp-elicitation:${message.id}`,
      { requireSelection: true, rawInput: isMcpToolCallApproval(params) ? mcpElicitationToolParams(params) : undefined },
    )
    const action = selected?.value
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new Error(`ACP host selected unknown MCP elicitation action '${String(action)}'`)
    }
    appWrite({
      id: message.id,
      result: action === 'accept' ? { action, content: {} } : { action, content: null },
    })
  } catch (error) {
    failApprovalLoud(
      message,
      'mcpServer/elicitation/request',
      itemId,
      params,
      error,
    )
  }
}

async function answerApproval(message, method) {
  const params = message.params ?? {}
  const itemId = String(params.itemId ?? message.id)
  const choices = method === 'item/permissions/requestApproval'
    ? permissionChoices()
    : approvalChoices(method, params)
  const title = method === 'item/commandExecution/requestApproval'
    ? commandApprovalTitle(params)
    : method === 'item/fileChange/requestApproval'
      ? fileApprovalTitle(params)
      : permissionApprovalTitle(params)
  let result
  try {
    if (choices.length === 0) {
      throw new Error(`${method} did not provide a renderable decision`)
    }
    const selected = await askHumanChoice(itemId, title, choices, `approval:${message.id}`, { subjectToolCall: { toolCallId: itemId } })
    if (method === 'item/permissions/requestApproval') {
      result = deniedPermissionResult()
      if (selected?.value === 'turn' || selected?.value === 'session') {
        result = {
          permissions: params.permissions ?? {},
          scope: selected.value,
          strictAutoReview: false,
        }
      }
    } else {
      result = { decision: selected?.value == null ? 'decline' : selected.value }
    }
  } catch (error) {
    // A user-selected Reject/Cancel is represented by `selected === null` above and is
    // deliberately returned as the provider's decline value.  An exception here means
    // the request was never rendered or delivered, so replying with decline would lie
    // to Codex and surface as "user rejected".
    failApprovalLoud(message, method, itemId, params, error)
    return
  }
  try {
    appWrite({ id: message.id, result })
  } catch (error) {
    process.stderr.write(
      `[codex-app-server-acp] ${method} response ${itemId} failed: ${error?.message ?? error}\n`,
    )
  }
}

async function answerUserInput(message) {
  const itemId = String(message.params?.itemId ?? '')
  // ⚠️ 缺省是 **true**,不是 false。上游自己的 wire 解码就是
  //    `is_blocking: wire.is_blocking.unwrap_or(true)`
  //    (`protocol/src/request_user_input.rs` 的手写 Deserialize)。
  //    写成 `=== true` 会让「字段没带」静默降级成「永不问人」—— 方向正好反了:
  //    这一维的 fail-safe 方向是**宁可停下来问**,不是替他决定。
  const isBlocking = message.params?.isBlocking !== false
  const answers = {}
  for (const question of message.params?.questions ?? []) {
    const id = String(question?.id ?? '').trim()
    if (!id) continue
    if (!questionIsRenderable(question, isBlocking)) {
      // ❌ 不许在这里编一个。渲染不出来 = 人没机会回答 = 如实说没有答案。
      answers[id] = { answers: [] }
      continue
    }
    try {
      answers[id] = { answers: await askHuman(itemId, { ...question, id }) }
    } catch (error) {
      // 人没回答(会话取消/连接断)同样是「没有答案」,不是「答了某个选项」。
      process.stderr.write(
        `[codex-app-server-acp] requestUserInput ${id} unanswered: ${error?.message ?? error}\n`,
      )
      answers[id] = { answers: [] }
    }
  }
  try {
    appWrite({ id: message.id, result: { answers } })
  } catch (error) {
    process.stderr.write(
      `[codex-app-server-acp] requestUserInput reply failed: ${error?.message ?? error}\n`,
    )
  }
}

function handleAppRequest(message) {
  const method = String(message.method ?? '')
  if (method === 'mcpServer/elicitation/request') {
    void answerMcpElicitation(message)
    return
  }
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  ) {
    void answerApproval(message, method)
    return
  }
  if (method === 'item/tool/requestUserInput') {
    void answerUserInput(message)
    return
  }
  appWrite({
    id: message.id,
    error: { code: -32601, message: `Gugu does not handle app-server request ${method}` },
  })
}

function onAppLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write(`[codex-app-server-acp] non-JSON app-server output: ${line.slice(0, 200)}\n`)
    return
  }
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const pending = appPending.get(message.id)
    if (!pending) return
    appPending.delete(message.id)
    if (message.error !== undefined) {
      const error = new Error(String(message.error?.message ?? 'Codex app-server error'))
      error.code = message.error?.code
      error.data = message.error?.data
      pending.reject(error)
    } else pending.resolve(message.result)
    return
  }
  if (message.id !== undefined && message.method) handleAppRequest(message)
  else if (message.method) onAppNotification(message)
}

async function handleAcpRequest(message) {
  const id = message.id
  const method = String(message.method ?? '')
  const params = message.params ?? {}
  auditAcpRequest(method, params)
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 2,
      capabilities: { session: { prompt: { image: {} }, mcp: { http: {} }, fork: {} } },
      info: { name: 'codex-app-server', version: 'local' },
    })
    return
  }
  if (method === '_session/revert') {
    if (!established || params.sessionId !== sessionId || typeof params.before !== 'string' || !params.before) {
      throw new Error('Invalid conversation revert target')
    }
    if (!historyCanRevert) throw new Error('Conversation revert requires persisted paginated Codex history')
    if (revertingHistory || activeCycle || runningCommands.size) {
      throw new Error('Wait for current work to finish before reverting')
    }
    revertingHistory = true
    try {
      const result = await appRequest('thread/revert', { threadId: sessionId, beforeTurnId: params.before })
      if (result?.thread?.id !== sessionId) throw new Error('Codex revert changed the thread ID')
      loadGeneration += 1
      respond(id, { sessionId })
    } finally { revertingHistory = false }
    return
  }
  if (method === 'session/fork') {
    await startApp(params.mcpServers)
    const requestedPermission = codexThreadPermissionFrom(params)
    // 运行时分叉(侧边聊天)不许在 codex 的线程台账里留痕 ⇒ `ephemeral: true`(缺省)。
    // 持久分叉(spec session-fork-share 的「Fork 会话」)正好相反:它就是要落成一条能重开的
    // 线程 ⇒ 宿主在 `_meta.gugu.ephemeralFork` 上显式给 `false`。
    // ❌ 不许把缺省当成「一定是运行时分叉」:那样持久分叉会开出一条重开即消失的会话,
    //    而症状要到用户下次打开它时才出现。
    const ephemeralFork = params?._meta?.gugu?.ephemeralFork !== false
    const forked = await appRequest('thread/fork', {
      threadId: params.sessionId,
      ephemeral: ephemeralFork,
      excludeTurns: true,
      cwd: params.cwd,
      ...(appServerThreadConfig ? { config: appServerThreadConfig } : {}),
      ...developerInstructionsFrom(params),
    })
    sessionId = String(forked?.thread?.id ?? '')
    if (!sessionId) throw new Error('local Codex thread/fork returned no thread id')
    // @@@fork-identity 持久分叉 = 新 agent。codex 不认 thread/fork 带的新指令(openai/codex#19045),
    // 模型仍读到源会话的身份 ⇒ 在历史末尾补一条只含身份差异与交接说明的开发者消息(见 codex-fork-handoff)。
    // 运行时分叉(侧边聊天)是同一个 agent,身份没变,❌ 不注入。
    if (!ephemeralFork) {
      await appRequest('thread/inject_items', {
        threadId: sessionId,
        items: codexForkHandoffItems(developerInstructionsFrom(params).developerInstructions),
      })
    }
    if (requestedPermission) {
      await appRequest('thread/settings/update', {
        threadId: sessionId,
        permissions: requestedPermission.profile,
      })
    }
    historyCanRevert = forked?.thread?.historyMode === 'paginated' && !forked?.thread?.ephemeral
    established = true
    const activePermissionProfile = forked?.activePermissionProfile
      ?? forked?.thread?.activePermissionProfile
    const modes = await probePermissionModes(params.cwd, activePermissionProfile)
    selectedPermissionProfile = requestedPermission?.profile
      ?? modes?.selected
      ?? permissionProfileId(activePermissionProfile)
    const responseModes = permissionModesWithRequestedProfile(modes, requestedPermission?.profile)
    // 顶层的 `model` / `reasoningEffort` 才是这条线程当前生效的那一对(实测:`result.thread`
    // 那层没有这两项)。⚠️ 读出来叫 `reasoningEffort`,写回去只认 `effort` —— 名字不对称。
    selectedModel = String(forked?.model ?? '').trim() || null
    selectedEffort = String(forked?.reasoningEffort ?? '').trim() || null
    const models = await modelCatalogOnce()
    respond(id, {
      sessionId,
            configOptions: withModelConfigOptions(
        withPermissionModeConfigOptions(forked?.configOptions, responseModes),
        selectedModel,
        selectedEffort,
        models
      ),
    })
    // fork 是侧聊那条路 —— 它同样是一条用户会在里面打 `/` 的会话。漏了它,侧聊的面板就是空的
    // (与「只在 new 里推、重开会话就空」是同一个形状,别只堵一半)。
    void publishAvailableCommands(params.cwd, params.additionalDirectories)
    return
  }
  if (method === '_session/async_task/stop') {
    const command = params.sessionId === sessionId && [...runningCommands.values()]
      .find((entry) => entry.turnId === null && entry.processId === params.asyncTaskId)
    respond(id, command ? await terminateCommand(command.processId) : { stopped: false })
    return
  }
  if (method === 'session/list') {
    const page = await readSessionList({ cursor: params.cursor ?? null })
    respond(id, { sessions: (page.data ?? []).map(thread => ({ sessionId: thread.id, cwd: thread.cwd,
      ...(thread.name || thread.preview ? { title: thread.name || thread.preview } : {}),
      ...(thread.updatedAt ? { updatedAt: new Date(thread.updatedAt * 1000).toISOString() } : {}) })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) })
    return
  }
  if (method === 'session/close') {
    const requestedSessionId = String(params.sessionId ?? '')
    if (!sessionId || requestedSessionId !== sessionId) {
      respond(id, null, {
        code: -32602,
        message: `cannot close Codex session ${requestedSessionId || '(missing)'}; adapter owns ${sessionId || '(none)'}`,
      })
      return
    }
    // The ACP runtime releases this adapter's exclusive process lease after this response.
    // Process teardown closes the app-server; do not resume/rejoin/unsubscribe another thread here.
    respond(id, {})
    return
  }
  if (method === 'session/new') {
    await startApp(params.mcpServers)
    const requestedPermission = codexThreadPermissionFrom(params)
    const started = await startThread({
      cwd: params.cwd,
      ...(appServerThreadConfig ? { config: appServerThreadConfig } : {}),
      ...(requestedPermission ? requestedPermission.threadStart : {}),
      ...developerInstructionsFrom(params),
    })
    sessionId = String(started?.thread?.id ?? '')
    if (!sessionId) throw new Error('local Codex thread/start returned no thread id')
    historyCanRevert = started?.thread?.historyMode === 'paginated' && !started?.thread?.ephemeral
    established = true
    const activePermissionProfile = started?.activePermissionProfile
      ?? started?.thread?.activePermissionProfile
    const modes = await probePermissionModes(params.cwd, activePermissionProfile)
    selectedPermissionProfile = requestedPermission?.profile
      ?? modes?.selected
      ?? permissionProfileId(activePermissionProfile)
    const responseModes = permissionModesWithRequestedProfile(modes, requestedPermission?.profile)
    // 顶层的 `model` / `reasoningEffort` 才是这条线程当前生效的那一对(实测:`result.thread`
    // 那层没有这两项)。⚠️ 读出来叫 `reasoningEffort`,写回去只认 `effort` —— 名字不对称。
    selectedModel = String(started?.model ?? '').trim() || null
    selectedEffort = String(started?.reasoningEffort ?? '').trim() || null
    // 顺手记下这个进程的 provider(见 @@@resume-provider)—— 有现成的回包就不必再起探针线程。
    if (!processModelProviderKnown && !processModelProviderInFlight) {
      processModelProviderKnown = true
      processModelProvider = String(started?.modelProvider ?? '').trim() || null
    }
    const models = await modelCatalogOnce()
    respond(id, {
      sessionId,
            configOptions: withModelConfigOptions(
        withPermissionModeConfigOptions(started?.configOptions, responseModes),
        selectedModel,
        selectedEffort,
        models
      ),
    })
    // 命令表在**回完 sessionId 之后**推:`session/update` 认 sessionId,先推客户端对不上号。
    void publishAvailableCommands(params.cwd, params.additionalDirectories)
    return
  }
  if (method === 'session/resume') {
    const generation = ++loadGeneration
    const loadStartedAt = Date.now()
    await startApp(params.mcpServers)
    const requestedPermission = codexThreadPermissionFrom(params)
    // 见 @@@resume-provider:resume 要用**这个进程**的 provider,❌ 不是 rollout 里记的那个。
    const resumeProvider = await processModelProviderOnce(params.cwd)
    const resumed = await appRequest('thread/resume', {
      threadId: params.sessionId,
      cwd: params.cwd,
      ...(resumeProvider ? { modelProvider: resumeProvider } : {}),
      ...(appServerThreadConfig ? { config: appServerThreadConfig } : {}),
      // 同 session/new:档位由 argv 单一决定。重开一个会话不该把它悄悄提到全权。
      ...developerInstructionsFrom(params),
    })
    sessionId = String(resumed?.thread?.id ?? params.sessionId ?? '')
    if (!sessionId) throw new Error('local Codex thread/resume returned no thread id')
    if (requestedPermission) {
      await appRequest('thread/settings/update', {
        threadId: sessionId,
        permissions: requestedPermission.profile,
      })
    }
    historyCanRevert = resumed?.thread?.historyMode === 'paginated' && !resumed?.thread?.ephemeral
    established = true
    // 宿主可以明说不要历史。咕咕聊天那条路(acp-host)自己存消息,并且在 load 期间丢弃一切回放的
    // session/update —— 给它拉历史是纯粹的浪费,还占着这次 load 的预算。默认仍然是重放:ACP 的
    // 语义就是 load 要把对话流回去,不吭声的宿主按契约办。
    const wantsReplay = params?._meta?.history?.replay !== false
    // 必须赶在 respond 之前:宿主拿到 load 的回包就退出 replaying 相位,之后到的历史不再算历史。
    // 截止时刻从 load 起点算 —— thread/resume 花掉的时间已经在里面了,不能当它免费。
    const replayDeadline = Math.min(
      Date.now() + REPLAY_BUDGET_MS,
      loadStartedAt + SESSION_LOAD_SOFT_BUDGET_MS,
    )
    if (!wantsReplay) {
      // 不出声:这是宿主主动选的,不是出了岔子。
    } else if (replayDeadline <= Date.now()) {
      process.stderr.write(
        '[codex-app-server-acp] history replay skipped: thread/resume already spent the session/load budget\n',
      )
    } else {
      await replayHistory(sessionId, generation, replayDeadline)
    }
    const activePermissionProfile = resumed?.activePermissionProfile
      ?? resumed?.thread?.activePermissionProfile
    const modes = await probePermissionModes(params.cwd, activePermissionProfile)
    // 顶层的 `model` / `reasoningEffort` 才是这条线程当前生效的那一对(实测:`result.thread`
    // 那层没有这两项)。⚠️ 读出来叫 `reasoningEffort`,写回去只认 `effort` —— 名字不对称。
    const resumedModel = String(resumed?.model ?? '').trim() || null
    const resumedEffort = String(resumed?.reasoningEffort ?? '').trim() || null
    // 这两个赋值排在 replayHistory 之后 —— 中间隔着一整段历史重放。宿主 load 超时会重发,
    // 于是**过期的那一次**可能在新的一次已经写好之后才走到这里,用更旧的读数把它盖掉。
    // 回包照旧要发(宿主还等着这个 id),但共享状态只让当前那一代写。
    if (generation === loadGeneration) {
      selectedModel = resumedModel
      selectedEffort = resumedEffort
      // 只记 provider 确实回报的档；目录探测失败时保留 thread/resume 给出的已知值。
      // active profile 本身缺席则保持 null，模型与会话生命周期不依赖这项可选观测。
      selectedPermissionProfile = requestedPermission?.profile
        ?? modes?.selected
        ?? permissionProfileId(activePermissionProfile)
    }
    const responseModes = permissionModesWithRequestedProfile(modes, requestedPermission?.profile)
    const models = await modelCatalogOnce()
    const resumedTurnId = activeTurnIdFromThread(resumed)
    if (resumedTurnId) beginCycle(resumedTurnId)
    sessionUpdate({ sessionUpdate: 'state_update', state: resumedTurnId ? 'running' : 'idle' })
    respond(id, {
            configOptions: withModelConfigOptions(
        withPermissionModeConfigOptions(resumed?.configOptions, responseModes),
        resumedModel,
        resumedEffort,
        models
      ),
    })
    // 重开的会话同样要报 —— 只在 new 里推的话,回到旧会话面板就是空的
    // (opencode 的 anomalyco#18819 正是这个形状,❌ 别自己再造一个)。
    void publishAvailableCommands(params.cwd, params.additionalDirectories)
    return
  }
  if (method === 'session/prompt') {
    if (revertingHistory) throw new Error('Conversation revert is in progress')
    if (!sessionId) throw new Error('no local Codex session')
    const input = promptInputItems(params.prompt)
    const insertion = expectPromptInsertion(id, params.prompt)
    const cycle = activeCycle
    const activeTurnId = cycle?.turnId ?? null
    if (joinPromptText(params.prompt).trim() === '/compact') {
      if (cycle || compactInsertion) throw new Error('local Codex cannot compact while foreground work is active')
      compactInsertion = insertion
      try {
        await appRequest('thread/compact/start', { threadId: sessionId })
        await receipt(id, insertion)
      } finally {
        if (compactInsertion === insertion) compactInsertion = null
      }
      return
    }
    if (activeTurnId) {
      try {
        await appRequest('turn/steer', { threadId: sessionId, input, expectedTurnId: activeTurnId,
          clientUserMessageId: insertion.clientId })
        await receipt(id, insertion)
        return
      } catch (error) {
        throwIfInsertionCancelled(insertion)
        if (insertion.messageId !== null) { await receipt(id, insertion); return }
        // A native cycle can end between observing it and the steer RPC. Wait only for that
        // specific cycle before submitting a new one; a receipt is never an end-of-work signal.
        process.stderr.write(`[codex-app-server-acp] turn/steer failed; retrying as turn/start: ${error?.message ?? error}\n`)
        if (activeCycle === cycle) await cycle.completion
      }
    }
    throwIfInsertionCancelled(insertion)
    const started = await appRequest('turn/start', { threadId: sessionId, input,
      clientUserMessageId: insertion.clientId })
    const turnId = String(started?.turn?.id ?? '')
    if (!turnId) throw new Error('local Codex turn/start returned no turn id')
    if (insertion.cancelled && activeCycle?.turnId === turnId) await cancelTurn(turnId)
    throwIfInsertionCancelled(insertion)
    await receipt(id, insertion)
    return
  }
  if (method === 'session/set_config_option') {
    // @@@codex-mode-switch — 会话中途切权限档。此前**根本没有这个分支**,于是用户在下拉里
    // 选一档就掉到下面那条 -32601,界面上显示 "Failed to change session mode":
    // 档位列得出来、切不动。
    if (!established) throw new Error('no local Codex session')
    if (params.type !== 'id') throw new Error('Codex config options require an id value')
    const configId = String(params.configId ?? '')

    // ── model / effort ────────────────────────────────────────────────────────
    //
    // ⚠️ `thread/settings/update` 对**不认识的键**和**不认识的值**一律沉默:实测传
    //    `{model:'__definitely-not-a-model__'}` 回 `{}`,传 `{reasoningEffort:'high'}`
    //    也回 `{}` 但那一轮照旧跑 low(正确的键是 `effort`)。⇒ 「回包没报错」在这里
    //    完全不是判据,校验只能由这一侧做,不认识的当场 -32602 fail loud。
    if (configId === 'model' || configId === 'effort') {
      const wantedValue = String(params.value ?? '').trim()
      const models = await modelCatalogOnce()
      if (models.length === 0) {
        respond(id, null, {
          code: -32603,
          message: 'local Codex model/list is unavailable; cannot apply a model or reasoning effort',
        })
        return
      }
      if (configId === 'model') {
        if (!models.some((model) => model.id === wantedValue)) {
          respond(id, null, {
            code: -32602,
            message: `unknown model: ${wantedValue}; local Codex offers ${models
              .map((model) => model.id)
              .join(', ')}`,
          })
          return
        }
        await appRequest('thread/settings/update', { threadId: sessionId, model: wantedValue })
        selectedModel = wantedValue
        // 换模型可能把当前档带出新模型的支持范围(真机实测:sol/terra 到 `ultra`,luna 到 `max`,
        // 5.5/5.2 只到 `xhigh` —— 三种不同的档位表)。带不动就落到**最近**的一档,
        // ❌ 不留一个这台 codex 在这个模型上并不接受的档在界面上。
        const nextEfforts = models.find((model) => model.id === wantedValue)?.efforts ?? []
        if (selectedEffort && !nextEfforts.includes(selectedEffort)) {
          selectedEffort = nearestSupportedEffort(selectedEffort, nextEfforts)
          if (selectedEffort) {
            await appRequest('thread/settings/update', { threadId: sessionId, effort: selectedEffort })
          }
        }
      } else {
        const efforts = models.find((model) => model.id === selectedModel)?.efforts ?? []
        if (!efforts.includes(wantedValue)) {
          respond(id, null, {
            code: -32602,
            message: `unknown reasoning effort: ${wantedValue}; model ${selectedModel} offers ${efforts.join(', ')}`,
          })
          return
        }
        // ⚠️ 键名是 `effort`。`reasoningEffort` / `reasoning_effort` 都被静默忽略
        //    —— 只有真机 rollout 对照才看得出来,别照 thread/start 报出来的那个名字写。
        await appRequest('thread/settings/update', { threadId: sessionId, effort: wantedValue })
        selectedEffort = wantedValue
      }
      const modes = await probePermissionModes(null, selectedPermissionProfile)
      respond(id, {
        configOptions: withModelConfigOptions(
          withPermissionModeConfigOptions(null, modes),
          selectedModel,
          selectedEffort,
          models
        ),
      })
      return
    }

    if (configId !== 'mode') {
      respond(id, null, { code: -32602, message: `unsupported configId: ${configId}` })
      return
    }
    const wanted = String(params.value ?? '').trim()
    // ⚠️ 用**当前档**去列表,❌ 不能用 wanted:loadPermissionModes() 会把传进去的「当前档」
    //    兜底追加进 available(codex 没列出来时也保证界面能显示它所处的档)。当前档未知时传 null,
    //    让 permissionProfile/list 本身做白名单；拿 wanted 冒充当前档会让校验永远通过。
    const modes = await loadPermissionModes(null, selectedPermissionProfile)
    // ❌ 不接受一个这台 codex 并不认识的档。thread/settings/update 是 partial update,
    //    省略即不改;传个它不认识的值,失败会浮到一个跟"切档"毫无关系的地方。这里当场 fail loud。
    if (wanted && !modes.available.some((mode) => mode.id === wanted)) {
      respond(id, null, {
        code: -32602,
        message: `unknown permission profile: ${wanted}; local Codex offers ${modes.available
          .map((mode) => mode.id)
          .join(', ')}`,
      })
      return
    }
    // codex app-server 的 `thread/settings/update`:给**已加载**线程排队一次 next-turn
    // 设置的部分更新,不起轮次、不加 transcript 条目(app-server README)。
    // `permissions` 就是按 id 选 profile,与 `sandboxPolicy` 互斥 —— 只传前者。
    // ⚠️ 它只认内存里的线程(load_thread → get_thread 只查内存表),所以必须在
    //    thread/start / thread/resume 之后调用,established 那个前置判断不能去掉。
    await appRequest('thread/settings/update', { threadId: sessionId, permissions: wanted })
    selectedPermissionProfile = wanted || null
    // 切权限档的回包也要带上 model / thought_level 两组 —— 只回 mode 一组,
    // 宿主的 deriveConfigGroups 会把没报的那两组读成 null,界面上模型与推理档当场消失。
    respond(id, {
      configOptions: withModelConfigOptions(
        ensurePermissionModeConfigOptions(null, selectedPermissionProfile, modes.available),
        selectedModel,
        selectedEffort,
        await modelCatalogOnce()
      ),
    })
    return
  }
  respond(id, null, { code: -32601, message: `unsupported ACP method: ${method}` })
}

function handleAcpNotification(message) {
  if (message.method === 'session/cancel' && message.params?.sessionId && message.params.sessionId !== sessionId) {
    void subagents.stop(message.params.sessionId).catch((error) => process.stderr.write(`[codex-subagents] stop failed: ${error.message}\n`))
    return
  }
  if (message.method === 'session/cancel') {
    for (const entry of promptInsertions.values()) if (entry.messageId === null) {
      entry.cancelled = true
      entry.resolve({ error: 'Request cancelled before insertion', code: -32800 })
    }

    // 人撤了这一轮 => 还在等他回答的提问就地了结(落到 `answers: []`),
    // 否则那条 promise 永不 settle,codex 的 turn 会一直挂着。
    cancelAcpPending('session cancelled')
  }
  if (message.method === 'session/cancel' && activeCycle) {
    void cancelTurn(activeCycle.turnId).catch((error) => {
      process.stderr.write(`[codex-app-server-acp] cancel failed: ${error.message}\n`)
    })
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write(`[codex-app-server-acp] non-JSON ACP input: ${line.slice(0, 200)}\n`)
    return
  }
  // 「只有 id、没有 method」= host 对**我们发出去的**请求的回答。原本没有这一支,
  // 整类响应被直接丢掉 —— 这正是 askUser 通不到人的物理原因之一。
  if (message.id !== undefined && !message.method) {
    if (!settleAcpResponse(message)) {
      process.stderr.write(`[codex-app-server-acp] unmatched ACP response id=${String(message.id)}\n`)
    }
    return
  }
  if (message.id !== undefined && message.method) {
    const run = () =>
      handleAcpRequest(message).catch((error) => {
        forgetPromptInsertion(message.id)
        respond(message.id, null, {
          code: typeof error.code === 'number' ? error.code : -32603,
          message: error.message || String(error),
          data: error.data,
        })
      })
    // 切档类请求**必须串行**。这个适配器对 ACP 请求不串行化(见上面 loadGeneration 那段),
    // 而 model / effort 两条分支读写同一组模块级状态,中间还有多个 await 让出事件循环:
    // 「切模型」与「切档」几乎同时到达时,后者会拿**旧模型**去校验并写下 selectedEffort,
    // 前者恢复后又按新模型判定它不支持、把用户刚显式选的那档静默回落掉;
    // 两个回包携带的 configOptions 谁先到还是竞态的,界面会停在与 codex 实际不符的状态。
    if (message.method === 'session/set_config_option') serializeConfigOption(run)
    else void run()
  } else if (message.method) handleAcpNotification(message)
})

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  cancelAcpPending('ACP host connection closed')
  for (const entry of promptInsertions.values()) entry.resolve({ error: 'ACP host connection closed' })
  promptInsertions.clear()
  appReader?.close()
  // Let approval handlers flush their explicit denial before stopping the local server.
  // Exit only once the app-server tree is down; a tree that will not stop exits non-zero, loud.
  setTimeout(() => {
    if (!appServer) process.exit(0)
    appServer.stop().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`gugu codex-acp: app-server tree stop failed: ${error.message}\n`)
        process.exit(1)
      },
    )
  }, 0)
}

reader.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
