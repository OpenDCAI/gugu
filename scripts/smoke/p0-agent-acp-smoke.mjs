#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'

const DEFAULT_CDP_URL = 'http://127.0.0.1:9333'
const DEFAULT_MAX_MS = 15_000
const DEFAULT_TIMEOUT_MS = 180_000

function parseArgs(argv) {
  const args = { _: [] }
  for (const item of argv) {
    if (!item.startsWith('--')) {
      args._.push(item)
      continue
    }
    const eq = item.indexOf('=')
    if (eq === -1) {
      args[item.slice(2)] = '1'
    } else {
      args[item.slice(2, eq)] = item.slice(eq + 1)
    }
  }
  return args
}

function readEnvFile(path) {
  if (!path || !existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numberArg(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`)
  return parsed
}

function isoNow() {
  return new Date().toISOString()
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitFor(label, fn, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}.${suffix}`)
}

function msBetween(start, end) {
  if (!start || !end) return null
  return Date.parse(end) - Date.parse(start)
}

function formatMs(ms) {
  return ms === null || !Number.isFinite(ms) ? null : `${ms}ms`
}

function mask(text) {
  if (!text) return ''
  if (text.length <= 8) return '<redacted>'
  return `${text.slice(0, 4)}...${text.slice(-4)}`
}

function makeSupabaseClient({ url, anonKey, accessToken, schema }) {
  return createClient(url, anonKey, {
    db: schema ? { schema } : undefined,
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function signInWithPassword({ url, anonKey, email, password }) {
  const auth = makeSupabaseClient({ url, anonKey })
  const { data, error } = await auth.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Supabase login failed: ${error.message}`)
  const session = data.session
  if (!session?.access_token || !session.user?.id) throw new Error('Supabase login returned no session')
  return {
    userId: session.user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  }
}

async function sessionFromRendererStorage(page, { url, anonKey }) {
  const raw = await page.evaluate(() => {
    const rows = []
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key) continue
      if (key === 'sb-main' || key.includes('auth-token')) {
        rows.push([key, window.localStorage.getItem(key)])
      }
    }
    return rows
  })
  for (const [key, value] of raw) {
    if (!value) continue
    try {
      const parsed = JSON.parse(value)
      const accessToken = parsed?.access_token ?? parsed?.currentSession?.access_token
      const refreshToken = parsed?.refresh_token ?? parsed?.currentSession?.refresh_token ?? null
      if (!accessToken) continue
      const auth = makeSupabaseClient({ url, anonKey })
      const { data, error } = await auth.auth.getUser(accessToken)
      if (error) throw error
      if (data.user?.id) return { userId: data.user.id, accessToken, refreshToken, storageKey: key }
    } catch {
      // Keep scanning; localStorage can hold unrelated JSON under auth-looking keys.
    }
  }
  return null
}

async function resolvePage(cdpUrl) {
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] ?? await browser.newContext()
  const page =
    context.pages().find((p) => p.url().startsWith('http') || p.url().startsWith('file:')) ??
    context.pages()[0] ??
    (await context.newPage())
  page.setDefaultTimeout(20_000)
  return { browser, page }
}

async function ensureLoggedIn(page, { email, password }) {
  const home = page.getByText('新建 Agent', { exact: false }).first()
  if (await home.isVisible().catch(() => false)) return
  if (!email || !password) {
    throw new Error('Renderer is not logged in; set P0_EMAIL/P0_PW or GUGU_SMOKE_EMAIL/GUGU_SMOKE_PASSWORD')
  }
  const emailInput = page.getByPlaceholder('邮箱地址')
  await emailInput.waitFor({ state: 'visible' })
  await emailInput.fill(email)
  const passwordInput = page.getByPlaceholder('密码', { exact: true })
  await passwordInput.fill(password)
  await passwordInput.press('Enter')
  await home.waitFor({ state: 'visible', timeout: 30_000 })
}

async function openCreateAgentModal(page) {
  const direct = page.getByText('新建 Agent', { exact: false }).first()
  if (await direct.isVisible().catch(() => false)) {
    await direct.click()
  } else {
    await page.getByRole('button', { name: '新建', exact: true }).click({ position: { x: 6, y: 12 } })
    await page.getByText('创建 Agent', { exact: true }).click()
  }
  const modal = page.locator('[data-testid="create-agent-modal"]')
  await modal.waitFor({ state: 'visible' })
  return modal
}

async function submitCreateAgent(page, { engine, runId, screenshotsDir }) {
  const modal = await openCreateAgentModal(page)
  await modal.locator(`[data-testid="create-agent-tool-${engine}"]`).click()
  const selfDevice = await page.evaluate(async () => {
    const api = window.electronAPI
    return api?.getLocalDeviceSelfSnapshot ? await api.getLocalDeviceSelfSnapshot() : null
  }).catch(() => null)
  const selfDeviceId = selfDevice && typeof selfDevice === 'object' ? selfDevice.device_id : null
  const deviceSelect = modal.locator('[data-testid="create-agent-device-select"]')
  if (typeof selfDeviceId === 'string' && selfDeviceId) {
    await deviceSelect.selectOption(selfDeviceId)
  }
  const selectedDeviceId = await deviceSelect.inputValue().catch(() => null)
  if (!selectedDeviceId) throw new Error('Create Agent device select has no selected device')
  if (selfDeviceId && selectedDeviceId !== selfDeviceId) {
    throw new Error(`Create Agent selected ${selectedDeviceId}, expected current Electron device ${selfDeviceId}`)
  }
  const spec = modal.locator('[data-testid="create-agent-spec-input"]')
  if (await spec.isVisible().catch(() => false)) {
    await spec.fill(`P0 A-gate smoke ${runId}: 收到消息后用一句中文确认在线。`)
  }
  const submit = modal.locator('[data-testid="create-agent-submit"]')
  await submit.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="create-agent-submit"]')
    return button instanceof HTMLButtonElement && !button.disabled
  }, { timeout: 20_000 })
  await page.screenshot({ path: resolve(screenshotsDir, '01-create-agent-form.png') }).catch(() => {})
  await submit.click()
  await modal.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {})
  await page.screenshot({ path: resolve(screenshotsDir, '02-create-agent-submitted.png') }).catch(() => {})
}

async function sendUserMessage(page, { text, screenshotsDir }) {
  const composer = page.locator('[data-testid="chat-composer"]')
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await composer.fill(text)
  await composer.press('Enter')
  await page.screenshot({ path: resolve(screenshotsDir, '03-user-message-sent.png') }).catch(() => {})
}

async function latestCommand(identity, { type, userId, sinceIso, engine, messageId, deviceId }) {
  const query = identity
    .from('gugu_device_commands')
    .select('id,user_id,device_id,type,status,payload,result,error,created_at,claimed_at,completed_at')
    .eq('type', type)
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(10)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const rows = Array.isArray(data) ? data : []
  return rows.find((row) => {
    const payload = row.payload ?? {}
    if (engine && payload.agent_type !== engine) return false
    if (messageId && payload.message_id !== messageId) return false
    if (deviceId && row.device_id !== deviceId) return false
    return true
  }) ?? null
}

async function commandById(identity, commandId) {
  const { data, error } = await identity
    .from('gugu_device_commands')
    .select('id,user_id,device_id,type,status,payload,result,error,created_at,claimed_at,completed_at')
    .eq('id', commandId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function waitForDoneCommand(identity, commandId, label, timeoutMs) {
  return waitFor(label, async () => {
    const row = await commandById(identity, commandId)
    if (row.status === 'error') throw new Error(`${label} failed: ${row.error || 'unknown error'}`)
    return row.status === 'done' ? row : null
  }, { timeoutMs, intervalMs: 1_000 })
}

async function latestMessage(chat, { chatId, senderUserId, sinceIso, content }) {
  const query = chat
    .from('messages')
    .select('id,chat_id,sender_user_id,to_user_ids,content,content_type,created_at,thread_root_id')
    .eq('chat_id', chatId)
    .eq('sender_user_id', senderUserId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(10)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  const rows = Array.isArray(data) ? data : []
  return rows.find((row) => (content ? row.content === content : true)) ?? null
}

function summarizeCommand(row) {
  return {
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    claim_ms: formatMs(msBetween(row.created_at, row.claimed_at)),
    done_ms: formatMs(msBetween(row.created_at, row.completed_at)),
  }
}

function assertSlo(label, ms, maxMs) {
  if (!maxMs) return
  if (!Number.isFinite(ms) || ms > maxMs) {
    throw new Error(`${label} exceeded ${maxMs}ms: ${ms}ms`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  readEnvFile(args['env-file'] || process.env.GUGU_SMOKE_ENV_FILE || '.env.local')

  const engine = args.engine || args._[0] || process.env.P0_ENGINE || 'claude-code'
  if (!['claude-code', 'codex'].includes(engine)) {
    throw new Error(`Unsupported engine "${engine}". Use claude-code or codex.`)
  }

  const cdpUrl = args.cdp || process.env.CDP_URL || DEFAULT_CDP_URL
  const supabaseUrl = required(args['supabase-url'] || process.env.GUGU_SUPABASE_URL || process.env.VITE_SUPABASE_URL, 'Supabase URL')
  const anonKey = required(args['anon-key'] || process.env.GUGU_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY, 'Supabase anon key')
  const email = args.email || process.env.P0_EMAIL || process.env.GUGU_SMOKE_EMAIL
  const password = args.password || process.env.P0_PW || process.env.GUGU_SMOKE_PASSWORD
  const maxMs = numberArg(args['max-ms'] ?? process.env.P0_MAX_MS, DEFAULT_MAX_MS, 'max-ms')
  const timeoutMs = numberArg(args.timeout ?? process.env.P0_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'timeout')
  const runId = args['run-id'] || `p0-${engine}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  const screenshotsDir = resolve(args.screenshots || process.env.P0_SCREENSHOTS_DIR || `artifacts/p0-agent-acp-smoke/${runId}`)
  mkdirSync(screenshotsDir, { recursive: true })

  console.log(`[p0-smoke] engine=${engine} cdp=${cdpUrl} supabase=${supabaseUrl} anon=${mask(anonKey)} run=${runId}`)

  const { browser, page } = await resolvePage(cdpUrl)
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 300))
  })
  page.on('pageerror', (err) => errors.push(`PAGEERR ${err.message.slice(0, 300)}`))

  try {
    await ensureLoggedIn(page, { email, password })
    const selfDevice = await page.evaluate(async () => {
      const api = window.electronAPI
      return api?.getLocalDeviceSelfSnapshot ? await api.getLocalDeviceSelfSnapshot() : null
    }).catch(() => null)
    const selfDeviceId = selfDevice && typeof selfDevice === 'object' ? selfDevice.device_id : null
    if (!selfDeviceId) throw new Error('Current Electron did not report a local runtime device id')
    console.log(`[p0-smoke] current_device=${selfDeviceId}`)
    const auth =
      email && password
        ? await signInWithPassword({ url: supabaseUrl, anonKey, email, password })
        : await sessionFromRendererStorage(page, { url: supabaseUrl, anonKey })
    if (!auth?.accessToken || !auth.userId) {
      throw new Error('Could not resolve an authenticated Supabase session for DB verification')
    }

    const identity = makeSupabaseClient({ url: supabaseUrl, anonKey, accessToken: auth.accessToken, schema: 'identity' })
    const chat = makeSupabaseClient({ url: supabaseUrl, anonKey, accessToken: auth.accessToken, schema: 'chat' })

    const createStartedAt = isoNow()
    await submitCreateAgent(page, { engine, runId, screenshotsDir })

    const createCommand = await waitFor('agent.create command row', () =>
      latestCommand(identity, { type: 'agent.create', userId: auth.userId, sinceIso: createStartedAt, engine, deviceId: selfDeviceId }),
    { timeoutMs: 45_000, intervalMs: 1_000 })
    const createDone = await waitForDoneCommand(identity, createCommand.id, 'agent.create command', timeoutMs)
    const createPayload = createDone.payload ?? {}
    const chatId = required(createPayload.greeting_chat_id, 'agent.create payload.greeting_chat_id')
    const agentUserId = required(createPayload.agent_user_id, 'agent.create payload.agent_user_id')

    const greeting = await waitFor('agent greeting message', () =>
      latestMessage(chat, {
        chatId,
        senderUserId: agentUserId,
        sinceIso: createDone.created_at,
      }),
    { timeoutMs, intervalMs: 1_000 })
    const createToGreetingMs = msBetween(createDone.created_at, greeting.created_at)
    assertSlo('create→greeting', createToGreetingMs, maxMs)

    const userText = `${runId} 你好，请用一句中文确认你在线。`
    const sendStartedAt = isoNow()
    await sendUserMessage(page, { text: userText, screenshotsDir })
    const userMessage = await waitFor('user chat.messages row', () =>
      latestMessage(chat, {
        chatId,
        senderUserId: auth.userId,
        sinceIso: sendStartedAt,
        content: userText,
      }),
    { timeoutMs: 30_000, intervalMs: 1_000 })
    const deliverCommand = await waitFor('agent.deliver command row', () =>
      latestCommand(identity, {
        type: 'agent.deliver',
        userId: auth.userId,
        sinceIso: sendStartedAt,
        messageId: userMessage.id,
        deviceId: selfDeviceId,
      }),
    { timeoutMs: 45_000, intervalMs: 1_000 })
    const deliverDone = await waitForDoneCommand(identity, deliverCommand.id, 'agent.deliver command', timeoutMs)
    const reply = await waitFor('agent reply message', () =>
      latestMessage(chat, {
        chatId,
        senderUserId: agentUserId,
        sinceIso: userMessage.created_at,
      }),
    { timeoutMs, intervalMs: 1_000 })
    const sendToReplyMs = msBetween(userMessage.created_at, reply.created_at)
    assertSlo('send→reply', sendToReplyMs, maxMs)
    await page.screenshot({ path: resolve(screenshotsDir, '04-agent-reply.png') }).catch(() => {})

    const summary = {
      run_id: runId,
      engine,
      user_id: auth.userId,
      chat_id: chatId,
      agent_user_id: agentUserId,
      slo_max_ms: maxMs || null,
      create: {
        command: summarizeCommand(createDone),
        greeting_message_id: greeting.id,
        greeting_created_at: greeting.created_at,
        create_to_greeting_ms: formatMs(createToGreetingMs),
        greeting_excerpt: String(greeting.content ?? '').slice(0, 160),
      },
      deliver: {
        user_message_id: userMessage.id,
        user_message_created_at: userMessage.created_at,
        command: summarizeCommand(deliverDone),
        reply_message_id: reply.id,
        reply_created_at: reply.created_at,
        send_to_reply_ms: formatMs(sendToReplyMs),
        reply_excerpt: String(reply.content ?? '').slice(0, 160),
      },
      screenshots_dir: screenshotsDir,
      console_errors: errors,
    }
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(`[p0-smoke] FAIL: ${error.message}`)
  process.exit(1)
})
