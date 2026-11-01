/**
 * #6264「从桌面用 SSH 一步装好」里与 Electron 无关的两件实事:真的 spawn 系统 ssh、以桌面的身份向云端要登录凭证。
 * 单独放一个文件,是为了 ipc.ts(要 electron)之外也能原样跑这条路径(本机对着容器实测时用)。
 */
import { spawn } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import type { RuntimeAuth } from '@gugu/core'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import type { MintGrant, SpawnSsh } from './runner'

const OUTPUT_CAP = 1024 * 1024

/**
 * 真的 spawn 系统 ssh。输出各自最多留 1MB(安装脚本的进度行不会超过这个量级)。
 * 标准输入是文件时(上传安装包)按流写进去,边写边报字节数;ssh 那头断了就停。
 */
export function systemSpawnSsh(env: NodeJS.ProcessEnv): SpawnSsh {
  return (args, { stdin, onStdout, onStderr, signal }) =>
    new Promise((resolve, reject) => {
      const child = spawn('ssh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve({ code, stdout, stderr })
      }
      // 取消 / 超时:杀掉这个 ssh 就算结束,❌ 等它的输出管道关上 —— 第一次连接时 ssh 会分出一个后台
      // 主连接(ControlPersist),它继承了这些管道,远端那条会话不结束它就不放手(实测:登录脚本里一句 sleep 100
      // 让「60 秒超时」拖到 101 秒)。主连接由调用方随后 `ssh -O exit` 收掉,远端那条会话随之断开。
      const onAbort = () => {
        if (child.exitCode !== null || child.signalCode !== null) return finish(child.exitCode)
        child.kill('SIGTERM')
        child.once('exit', (code) => {
          child.stdout.destroy()
          child.stderr.destroy()
          finish(code)
        })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (stdout.length < OUTPUT_CAP) stdout += chunk
        onStdout?.(chunk)
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        if (stderr.length < OUTPUT_CAP) stderr += chunk
        onStderr?.(chunk)
      })
      child.stdin.on('error', () => undefined)
      child.on('error', (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code) => finish(code))
      if (typeof stdin === 'string') {
        child.stdin.end(stdin)
      } else {
        const source = fs.createReadStream(stdin.file)
        let sent = 0
        source.on('data', (chunk) => {
          sent += chunk.length
          stdin.onProgress?.(sent)
        })
        source.on('error', () => child.kill('SIGTERM'))
        source.pipe(child.stdin)
      }
    })
}

/** 以桌面此刻登着的身份要一条已批准的登录请求。令牌由渲染进程续期并推给主进程;这里拿到的就是最新的那份,401 即没登录。 */
export function cloudMintGrant(getAuth: () => Promise<RuntimeAuth | null>): MintGrant {
  return async (machine) => {
    const auth = await getAuth().catch(() => null)
    if (!auth) return { error: 'notSignedIn' }
    let response: Response
    try {
      response = await fetch(`${getSupabaseUrl().replace(/\/$/, '')}/functions/v1/server-login/grant`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: getSupabaseAnonKey(),
          authorization: `Bearer ${auth.accessToken}`,
        },
        body: JSON.stringify({ machine }),
      })
    } catch (error) {
      return { error: 'grantFailed', detail: error instanceof Error ? error.message : String(error) }
    }
    const data = (await response.json().catch(() => ({}))) as { device_code?: unknown; error?: unknown }
    if (response.ok && typeof data.device_code === 'string') return { deviceCode: data.device_code }
    if (response.status === 401) return { error: 'notSignedIn' }
    return { error: 'grantFailed', detail: `${response.status} ${String(data.error ?? '')}`.trim() }
  }
}
