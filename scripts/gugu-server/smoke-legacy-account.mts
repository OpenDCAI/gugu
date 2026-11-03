#!/usr/bin/env node
// Released 1126/1131 supervisors create this skeleton before run-account, without prepare-install.
// Keep this compatibility probe independent of the current checkAccountBoot's installation preparation.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const binary = process.argv[2]
if (!binary || !path.isAbsolute(binary)) throw new Error('An absolute packaged server binary is required')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-legacy-boot-'))
if (!fixture.startsWith(path.join(os.tmpdir(), 'gugu-legacy-boot-'))) throw new Error('Unexpected fixture path')
// Keep OS caches (including Rosetta's) outside the installation, as in a real user home.
const home = path.join(fixture, '.gugu-server')
const userId = randomUUID()
const account = path.join(home, 'accounts', userId)
const data = path.join(account, 'data')
fs.mkdirSync(data, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(account, 'account.json'), '{}', { mode: 0o600 })
const env = { ...process.env, GUGU_SERVER_HOME: home, GUGU_HOME: path.join(account, 'home'),
  GUGU_TASK_HOST_USER_DATA: data, GUGU_USER_DATA_DIR: data,
  GUGU_SERVER_ACCOUNT: userId, GUGU_SERVER_WAIT_PID: '', HOME: fixture, USERPROFILE: fixture }
// Real account data without a verifiable source must still fail, with the exact migration error.
const existing = path.join(data, 'existing-account-state')
fs.writeFileSync(existing, 'existing account state', { mode: 0o600 })
const refused = spawnSync(binary, ['run-account', userId], { env, encoding: 'utf8', timeout: 45_000 })
const refusal = '[server] Error: Existing account environment cannot be verified; explicit migration is required'
if (refused.status !== 1 || !refused.stderr.split('\n').includes(refusal)
  || fs.existsSync(path.join(home, 'current')) || fs.existsSync(path.join(home, 'installation.json'))
  || fs.readFileSync(existing, 'utf8') !== 'existing account state') {
  throw new Error(`Legacy account migration refusal changed (${refused.status})\n${refused.stderr}`)
}
console.log(`legacy account data refused: ${refusal}`)
fs.unlinkSync(existing)
const ready = Promise.withResolvers<void>()
const startedAt = Date.now()
const checkReady = () => {
  try {
    const activity = JSON.parse(fs.readFileSync(path.join(data, 'activity.json'), 'utf8'))
    if (activity.pid === child.pid && Number.isFinite(activity.startedAt) && activity.startedAt >= startedAt
      && Number.isFinite(activity.at) && activity.at >= activity.startedAt && activity.at <= Date.now()) ready.resolve()
  } catch { /* A partial heartbeat write is not readiness. */ }
}
const child = spawn(binary, ['run-account', userId], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
})
console.log(`legacy boot probe launched: pid=${child.pid}`)
let output = Buffer.alloc(0)
const collect = (chunk: Buffer) => { output = Buffer.concat([output, chunk]).subarray(-16_384) }
child.stdout.on('data', collect)
child.stderr.on('data', collect)
child.on('error', error => ready.reject(error))
const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
child.once('exit', code => ready.reject(new Error(`Legacy account boot exited before readiness (${code})`)))
const readiness = setInterval(checkReady, 200)
checkReady()
const timeout = setTimeout(() => ready.reject(new Error('Legacy account boot did not publish PID-bound readiness')), 45_000)
try {
  await ready.promise
  console.log(`legacy boot ready: pid=${child.pid}`)
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.toString()}`, { cause: error })
} finally {
  clearTimeout(timeout)
  clearInterval(readiness)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(kill)
  console.log(`remove legacy boot fixture: ${fixture}`)
  fs.rmSync(fixture, { recursive: true, force: true })
}
if (child.exitCode !== 0 && child.exitCode !== 143 && child.signalCode !== 'SIGTERM') {
  throw new Error(`Legacy account boot exited with ${child.exitCode}, signal ${child.signalCode}\n${output.toString()}`)
}
