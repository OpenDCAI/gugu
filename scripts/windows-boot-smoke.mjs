#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const executable = resolve(process.argv[2] ?? '')
const timeoutSeconds = Number.parseInt(process.argv[3] ?? '120', 10)

if (process.platform !== 'win32') {
  throw new Error('windows-boot-smoke.mjs must run on Windows')
}
if (!process.argv[2] || !existsSync(executable)) {
  throw new Error(`packaged executable does not exist: ${executable}`)
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) {
  throw new Error(`invalid timeout: ${process.argv[3]}`)
}

const appRoot = join(dirname(executable), 'resources', 'app')
const watcherPackage = join(appRoot, 'node_modules', '@parcel', 'watcher-win32-x64')
if (!existsSync(watcherPackage)) {
  throw new Error(`packaged Windows watcher is missing: ${watcherPackage}`)
}

const smokeRoot = mkdtempSync(join(tmpdir(), 'gugu-windows-smoke-'))
const userData = join(smokeRoot, 'user-data')
const output = []
const rendererExceptions = []
let child
let childExit = null
let socket

function appendOutput(data) {
  output.push(String(data))
  if (output.length > 2_000) output.shift()
}

function diagnostics() {
  const logPath = join(userData, 'logs', 'gugu-main.log')
  let fileLog = ''
  try {
    fileLog = readFileSync(logPath, 'utf8')
  } catch {
    // The app may be creating or rotating the log while the smoke reads it.
  }
  return [...output, fileLog].join('').slice(-12_000)
}

function terminateProcessTree() {
  if (!child?.pid || childExit) return
  spawnSync('tasklist.exe', ['/FI', `PID eq ${child.pid}`], { stdio: 'inherit' })
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit' })
}

function cleanup() {
  try {
    socket?.close()
  } catch {
    // A connection attempt can still be in progress when an early boot failure exits the script.
  }
  terminateProcessTree()
  try {
    // Chromium child processes can release profile handles a few seconds after taskkill returns.
    rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 1_000 })
  } catch (error) {
    console.warn(`[windows-boot-smoke] temporary profile cleanup failed: ${error}`)
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// @@@single-cap (#4357) — 唯一的墙钟上限是 workflow 传进来的 <timeoutSeconds>,放在最外层一次性计时;
// 里面每一步(CDP 连上、命令应答、后端 boot OK、渲染就绪)都只等事实,不各自带预算。
// 到点时报出**当时停在哪一步**,而不是一句笼统的超时。
let currentStep = 'launch-app'
function step(name) {
  if (currentStep === name) return
  currentStep = name
  console.log(`[windows-boot-smoke] step=${name}`)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((error) =>
        error || !port ? reject(error ?? new Error('no port')) : resolvePort(port)
      )
    })
  })
}

async function getPageTarget(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return null
    const targets = await response.json()
    return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null
  } catch {
    return null
  }
}

async function connectRuntime(target) {
  const pending = new Map()
  let commandId = 0
  socket = new WebSocket(target.webSocketDebuggerUrl)

  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', reject, { once: true })
    socket.addEventListener('close', () => reject(new Error('CDP websocket closed before it opened')), { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') {
      rendererExceptions.push(
        message.params?.exceptionDetails?.text ?? JSON.stringify(message.params)
      )
      return
    }
    if (!message.id) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('CDP websocket closed'))
    pending.clear()
  }
  socket.addEventListener('close', rejectPending)
  socket.addEventListener('error', rejectPending)

  // 逐条命令的 5s 不是判据:它到点只让这一轮轮询放弃这条命令、回到循环顶上去读日志与进程状态
  // (后端 boot 失败、进程退出都在那里被认出来)。没有它,一条卡住的 evaluate 会把这些检查一起卡住。
  const command = (method, params = {}) =>
    new Promise((resolveCommand, reject) => {
      const id = ++commandId
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, 5_000)
      pending.set(id, {
        resolve(value) {
          clearTimeout(timeout)
          resolveCommand(value)
        },
        reject(error) {
          clearTimeout(timeout)
          reject(error)
        }
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  await command('Runtime.enable')
  return command
}

// 判定在这之前已经做完(OK 已打印);这里只是收尾的礼貌:请它自己退出,给它一段时间,
// 不退就由 cleanup 的 taskkill 收掉。这段时间不决定任何红绿,所以不属于 #4357 要收的那类预算。
async function closeAppGracefully(command) {
  command('Browser.close').catch((error) => {
    appendOutput(`[windows-boot-smoke] graceful close failed: ${error}\n`)
  })

  const closeDeadline = Date.now() + 10_000
  while (!childExit && Date.now() < closeDeadline) await delay(250)
}

const port = await reservePort()
child = spawn(executable, [`--remote-debugging-port=${port}`, '--disable-gpu'], {
  cwd: dirname(executable),
  env: {
    ...process.env,
    GUGU_LOG_STDOUT: '1',
    GUGU_USER_DATA_DIR: userData,
    ELECTRON_ENABLE_LOGGING: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false
})
child.stdout.on('data', appendOutput)
child.stderr.on('data', appendOutput)
child.once('exit', (code, signal) => {
  childExit = { code, signal }
})

let command
let rendererState
const overallCap = setTimeout(() => {
  console.error(
    `[windows-boot-smoke] ${timeoutSeconds}s timeout at step=${currentStep}; renderer=${JSON.stringify(rendererState)}, exceptions=${JSON.stringify(rendererExceptions)}\n${diagnostics()}`
  )
  process.exit(1)
}, timeoutSeconds * 1_000)
for (;;) {
  if (childExit) {
    throw new Error(
      `app exited before smoke passed (${JSON.stringify(childExit)})\n${diagnostics()}`
    )
  }
  const logs = diagnostics()
  if (/\[sessionpage\] (FAILED|boot failed)/.test(logs)) {
    throw new Error(`session-page backend failed during boot\n${logs}`)
  }

  if (!command) {
    step('wait-for-cdp-page-target')
    const target = await getPageTarget(port)
    if (target) {
      step('connect-cdp')
      try {
        command = await connectRuntime(target)
      } catch (error) {
        appendOutput(`[windows-boot-smoke] CDP connect retry: ${error}\n`)
        command = undefined
      }
    }
  }
  if (command) {
    try {
      const evaluated = await command('Runtime.evaluate', {
        expression: `({ title: document.title, body: document.body?.innerText?.trim() ?? '', readyState: document.readyState })`,
        returnByValue: true
      })
      if (evaluated.exceptionDetails) {
        rendererExceptions.push(
          evaluated.exceptionDetails.text ?? JSON.stringify(evaluated.exceptionDetails)
        )
      } else {
        rendererState = evaluated.result?.value
      }
    } catch (error) {
      appendOutput(`[windows-boot-smoke] CDP evaluate retry: ${error}\n`)
      command = undefined
    }
  }

  const backendReady = logs.includes('[sessionpage] boot OK')
  const rendererReady = rendererState?.readyState === 'complete' && rendererState.body.length > 0
  if (command) {
    step(`wait-for-boot backend=${backendReady ? 'ready' : 'waiting'} renderer=${rendererReady ? 'ready' : 'waiting'}`)
  }
  if (backendReady && rendererReady && rendererExceptions.length === 0) {
    console.log(
      `[windows-boot-smoke] OK: ${basename(executable)}, renderer="${rendererState.body.replaceAll(/\s+/g, ' ').slice(0, 120)}"`
    )
    clearTimeout(overallCap)
    step('close-app')
    await closeAppGracefully(command)
    cleanup()
    process.off('exit', cleanup)
    process.exit(0)
  }
  await delay(500)
}
