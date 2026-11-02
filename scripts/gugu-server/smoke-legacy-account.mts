#!/usr/bin/env node
// Released 1126/1131 supervisors create this skeleton before run-account, without prepare-install.
// Keep this compatibility probe independent of the current checkAccountBoot's installation preparation.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const binary = process.argv[2]
if (!binary || !path.isAbsolute(binary)) throw new Error('An absolute packaged server binary is required')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-legacy-boot-'))
if (!home.startsWith(path.join(os.tmpdir(), 'gugu-legacy-boot-'))) throw new Error('Unexpected fixture path')
const userId = randomUUID()
const account = path.join(home, 'accounts', userId)
const data = path.join(account, 'data')
fs.mkdirSync(data, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(account, 'account.json'), '{}', { mode: 0o600 })
const ready = Promise.withResolvers<void>()
const startedAt = Date.now()
const watcher = fs.watch(data, (_event, file) => {
  if (file?.toString() !== 'activity.json') return
  try {
    const activity = JSON.parse(fs.readFileSync(path.join(data, 'activity.json'), 'utf8'))
    if (activity.pid === child.pid && Number.isFinite(activity.startedAt) && activity.startedAt >= startedAt
      && Number.isFinite(activity.at) && activity.at >= activity.startedAt && activity.at <= Date.now()) ready.resolve()
  } catch { /* A partial heartbeat write is not readiness. */ }
})
watcher.on('error', error => ready.reject(error))
const child = spawn(binary, ['run-account', userId], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GUGU_SERVER_HOME: home, GUGU_HOME: path.join(account, 'home'),
    GUGU_TASK_HOST_USER_DATA: data, GUGU_USER_DATA_DIR: data,
    GUGU_SERVER_ACCOUNT: userId, GUGU_SERVER_WAIT_PID: '', HOME: home, USERPROFILE: home },
})
console.log(`legacy boot probe launched: pid=${child.pid}`)
let output = Buffer.alloc(0)
const collect = (chunk: Buffer) => { output = Buffer.concat([output, chunk]).subarray(-16_384) }
child.stdout.on('data', collect)
child.stderr.on('data', collect)
child.on('error', error => ready.reject(error))
const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
child.once('exit', code => ready.reject(new Error(`Legacy account boot exited before readiness (${code})`)))
const timeout = setTimeout(() => ready.reject(new Error('Legacy account boot did not publish PID-bound readiness')), 45_000)
try {
  await ready.promise
  console.log(`legacy boot ready: pid=${child.pid}`)
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.toString()}`, { cause: error })
} finally {
  clearTimeout(timeout)
  watcher.close()
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(kill)
  console.log(`remove legacy boot fixture: ${home}`)
  fs.rmSync(home, { recursive: true, force: true })
}
if (child.exitCode !== 0 && child.exitCode !== 143 && child.signalCode !== 'SIGTERM') {
  throw new Error(`Legacy account boot exited with ${child.exitCode}, signal ${child.signalCode}\n${output.toString()}`)
}
