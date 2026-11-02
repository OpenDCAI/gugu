import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binLauncher, ownServerNames, serverNames, type ServerNames } from './server-names'

/** An installed package belongs to its managed home, including pre-channel installations. */
export function resolveServerHome(env: NodeJS.ProcessEnv = process.env, userHome = os.homedir(), names = ownServerNames()): string {
  const configured = env.GUGU_SERVER_HOME?.trim()
  if (configured) {
    const resolved = path.resolve(configured)
    return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
  }
  if (env.GUGU_TASK_HOST_APP_PATH) {
    const app = path.resolve(env.GUGU_TASK_HOST_APP_PATH)
    const versions = path.dirname(path.dirname(app))
    const home = path.dirname(versions)
    if (path.basename(app) === 'app' && path.basename(versions) === 'versions'
      && fs.existsSync(path.join(home, 'channel'))) return home
  }
  return path.join(userHome, names.homeDir)
}

function isLegacyChannelHome(home: string, names: ServerNames, userHome: string): boolean {
  if (!home || names.homeDir === '.gugu-server') return false
  try {
    if (fs.realpathSync(home) !== fs.realpathSync(path.join(userHome, '.gugu-server'))) return false
    return fs.readFileSync(path.join(home, 'channel'), 'utf8').trim() === names.bin.slice('gugu-server-'.length)
  }
  catch { return false }
}

/** Existing services and tmux sockets retain their names when their installation upgrades. */
export function installationServerNames(home: string, names = ownServerNames(), userHome = os.homedir()): ServerNames {
  const resolved = home && fs.existsSync(home) ? fs.realpathSync(home) : home
  return isLegacyChannelHome(resolved, names, userHome) ? serverNames('stable') : names
}

/** Publish the channel command for a legacy installation without replacing another installation. */
export function repairLegacyServerLaunchers(home: string, names = ownServerNames(), userHome = os.homedir()): void {
  if (!isLegacyChannelHome(home, names, userHome)) return
  const executable = path.join(home, 'current', 'bin', 'gugu-server')
  if (!fs.existsSync(executable)) return
  const channelHome = path.join(userHome, names.homeDir)
  let aliasExists = false
  try {
    const alias = fs.lstatSync(channelHome)
    if (alias.isDirectory() && !alias.isSymbolicLink() && fs.readdirSync(channelHome).length === 0) fs.rmdirSync(channelHome)
    else {
      if (fs.realpathSync(channelHome) !== fs.realpathSync(home)) return
      aliasExists = true
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!aliasExists) fs.symlinkSync(home, channelHome, 'dir')
  const dir = path.join(userHome, '.local', 'bin')
  fs.mkdirSync(dir, { recursive: true })
  const content = binLauncher(home)
  for (const name of [names.bin, 'gugu-server']) {
    const target = path.join(dir, name)
    let existing: fs.Stats | undefined
    try { existing = fs.lstatSync(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing) {
      // A user script or another channel's command is not ours to replace.
      if (!existing.isSymbolicLink()) continue
      try { if (fs.realpathSync(target) !== fs.realpathSync(executable)) continue } catch { continue }
    }
    const tmp = `${target}.install-${process.pid}`
    try {
      fs.writeFileSync(tmp, content, { mode: 0o755, flag: 'wx' })
      if (existing) {
        const now = fs.lstatSync(target)
        if (now.ino !== existing.ino || now.dev !== existing.dev || now.mtimeMs !== existing.mtimeMs) continue
        fs.renameSync(tmp, target)
      } else {
        try { fs.linkSync(tmp, target) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
    } finally { fs.rmSync(tmp, { force: true }) }
  }
}
