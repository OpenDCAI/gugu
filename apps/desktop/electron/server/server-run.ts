/** One installation, one signed-in account, one long-lived server process. */
import path from 'node:path'
import fs from 'node:fs'
import { claimHomeLock, markServerReady, onlySignedInAccount, ownsHomeLock } from './server-startup'
import { EXIT_CONFIG } from './server-exit'
import { applyLoginShell, clearStopped, liveKeeperPid, markStopped, startKeeper } from './server-keeper'
import { listAccounts, serverHome, supervisorDataDir } from './server-layout'
import { managedLayout, startServerUpdater } from './server-updater'
import { repairLegacyServerLaunchers } from './server-installation'
import { repairServiceDefinition } from './server-service'
import { removeLegacyBrowserLogins } from '../lib/remove-legacy-browser-logins'
import { SUPERVISOR_HEALTH_MS, writeSupervisorHealth } from './server-health'

export async function runSingleServer(prepare: () => void, runAccount: (userId: string) => Promise<void>): Promise<void> {
  const home = serverHome()
  const warn = (message: string): void => { process.stderr.write(`[server] ${message}\n`) }
  const exitConfig = (message: string): never => {
    warn(message)
    if (process.env.GUGU_SERVER_SUPERVISED !== 'systemd') markStopped(home)
    process.exit(EXIT_CONFIG)
  }
  const release = claimHomeLock(home)
  if (!release) {
    let holder: number | null = null
    try { holder = Number(fs.readFileSync(path.join(home, 'data/server.lock'), 'utf8')) } catch { /* The holder may have just exited. */ }
    warn(`Another server already holds this installation’s lock (pid ${holder && Number.isInteger(holder) ? holder : 'unknown'})`)
    process.exit(EXIT_CONFIG)
  }
  process.on('exit', release)
  prepare()
  const layout = managedLayout()
  if (layout) {
    try { fs.rmSync(path.join(home, 'versions/.prepared', path.basename(layout.running)), { force: true }) }
    catch (error) { warn(`Could not release the installation lease: ${String(error)}`) }
  }
  repairServiceDefinition(warn)
  try { repairLegacyServerLaunchers(home) } catch (error) { warn(`Could not repair the legacy command: ${String(error)}`) }
  clearStopped(home)
  applyLoginShell(home)
  const startedAt = Date.now()
  const health = () => {
    if (!ownsHomeLock(home)) {
      warn('Installation lock ownership was lost; stopping this server.')
      process.exit(EXIT_CONFIG)
    }
    writeSupervisorHealth(home, { version: process.env.GUGU_TASK_HOST_VERSION ?? null, pid: process.pid, startedAt })
  }
  health()
  setInterval(health, SUPERVISOR_HEALTH_MS).unref()
  for (const account of listAccounts()) removeLegacyBrowserLogins(account.dataDir, { info: warn, warn })

  const stopWhileWaiting = (): void => {
    if (!['systemd', 'launchd'].includes(process.env.GUGU_SERVER_SUPERVISED ?? '')) markStopped(home)
    process.exit(143)
  }
  process.on('SIGTERM', stopWhileWaiting)
  process.on('SIGINT', stopWhileWaiting)
  let account
  try { account = onlySignedInAccount(listAccounts()) }
  catch (error) { return exitConfig(error instanceof Error ? error.message : String(error)) }
  if (!process.env.GUGU_SERVER_SUPERVISED && layout && liveKeeperPid(home) === null) {
    startKeeper({ home, logFile: path.join(supervisorDataDir(), 'logs/service.log'), adoptPid: process.pid })
  }
  if (!account) {
    markServerReady(home)
    process.stdout.write('[server] Not signed in; waiting for login.\n')
  }
  let bootingAccount = Boolean(account)
  const updater = startServerUpdater({ isBusy: () => bootingAccount,
    shutdown: () => process.exit(75),
    log: { info: (message, fields) => warn(`${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
      warn: (message, fields) => warn(`${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`) } })
  process.on('exit', () => updater.dispose())
  if (!account) {
    while (!account) {
      await new Promise(resolve => setTimeout(resolve, 3_000))
      try { account = onlySignedInAccount(listAccounts()) }
      catch (error) { return exitConfig(error instanceof Error ? error.message : String(error)) }
    }
  }
  process.removeListener('SIGTERM', stopWhileWaiting)
  process.removeListener('SIGINT', stopWhileWaiting)
  bootingAccount = true
  await runAccount(account.userId)
}
