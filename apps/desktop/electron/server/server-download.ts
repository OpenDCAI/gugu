import fs from 'node:fs'
import path from 'node:path'

/**
 * 咕咕 server 的下载站根地址:install.sh、自动升级、桌面经 SSH 装,三处读同一个。
 * 开发 / 测试时用 GUGU_SERVER_DOWNLOAD_BASE 指到别处(比如本机起的静态服务)。
 * 装在那台机器上的 server 自己没有这个环境变量:install.sh 装时把指定的下载站记在
 * `<GUGU_SERVER_HOME>/download-base`,后台自动升级读它,❌ 回退到正式站(测试机上会 404)。
 */
export const SERVER_DOWNLOAD_BASE_FILE = 'download-base'
export const SERVER_DOWNLOAD_BASE_DEFAULT = 'https://download.gugu.nextmind.space/releases/server'

export function serverDownloadBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GUGU_SERVER_DOWNLOAD_BASE?.trim() || recordedDownloadBase(env) || SERVER_DOWNLOAD_BASE_DEFAULT).replace(/\/$/, '')
}

function recordedDownloadBase(env: NodeJS.ProcessEnv): string | null {
  const home = env.GUGU_SERVER_HOME?.trim()
  if (!home) return null
  try {
    const text = fs.readFileSync(path.join(home, SERVER_DOWNLOAD_BASE_FILE), 'utf8').trim()
    return /^https?:\/\/\S+$/.test(text) ? text : null
  } catch {
    return null
  }
}
