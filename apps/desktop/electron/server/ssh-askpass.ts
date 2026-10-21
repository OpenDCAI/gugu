/**
 * ssh 要密码、密钥口令,或第一次连一台机器要确认指纹时,在咕咕里问人(behavior「要密码或密钥口令时在咕咕里问,❌ 卡住不动」)。
 *
 * 做法与 VS Code 的 git askpass 同:ssh 没有终端可问时,会执行 SSH_ASKPASS 指向的程序、把提示当参数传给它、
 * 读它 stdout 的一行当回答(SSH_ASKPASS_REQUIRE=force 让 OpenSSH 8.4+ 即便有别的途径也走它)。
 * 我们的 askpass 是一个小脚本:用 Electron 自己当 node(ELECTRON_RUN_AS_NODE=1)连回主进程的本机套接字,
 * 把提示交过来、等人回答。套接字所在目录只有本用户可进(0700),每次安装一个随机令牌,令牌不对不答。
 *
 * 人点「取消」= 脚本以非零退出 = ssh 当作没给口令 / 不认这台机器,连接失败并报出原因。
 *
 * SSH_ASKPASS_PROMPT=none(「请触碰你的安全密钥」这类只提醒、不要回答的):ssh 不等 askpass 的输出,
 * 事情办完就把它杀掉 —— 这时套接字断开,handler 收到的 signal 随之 abort,界面上的提醒自己消失。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export type AskpassQuestion = {
  prompt: string
  /** ssh 给的 SSH_ASKPASS_PROMPT:''(要回答)、'confirm'(是/否)、'none'(只是提醒)。 */
  mode: string
  /** askpass 进程没等到回答就走了(ssh 杀掉了它)。 */
  signal: AbortSignal
}
/** 回答;null = 人取消了。 */
export type AskpassHandler = (question: AskpassQuestion) => Promise<string | null>

export type AskpassSession = {
  /** 交给 ssh 子进程的环境变量。 */
  env: NodeJS.ProcessEnv
  close: () => Promise<void>
}

// askpass 进程本身:连套接字、发一行 JSON、收一行 JSON。故意写成不依赖任何包的一小段。
const ASKPASS_JS = `'use strict'
const net = require('net')
const socket = net.connect(process.env.GUGU_ASKPASS_SOCKET)
let buffered = ''
socket.on('connect', () => {
  socket.write(JSON.stringify({ token: process.env.GUGU_ASKPASS_TOKEN, prompt: process.argv[2] || '', mode: process.env.SSH_ASKPASS_PROMPT || '' }) + '\\n')
})
socket.on('data', (chunk) => { buffered += chunk })
socket.on('end', () => {
  try {
    const reply = JSON.parse(buffered)
    if (reply && reply.ok && typeof reply.value === 'string') {
      process.stdout.write(reply.value + '\\n')
      process.exit(0)
    }
  } catch (e) {}
  process.exit(1)
})
socket.on('error', () => process.exit(1))
`

/**
 * 在 `dir`(调用方建好、0700)里放好 askpass 脚本并开始监听。
 * Windows 上 ssh 要的是可执行文件,那里用 .cmd 包一层;套接字换成命名管道。
 */
export async function startAskpass(options: {
  dir: string
  nodeExecutable: string
  handler: AskpassHandler
}): Promise<AskpassSession> {
  const token = crypto.randomBytes(24).toString('hex')
  const jsPath = path.join(options.dir, 'askpass.cjs')
  fs.writeFileSync(jsPath, ASKPASS_JS, { mode: 0o600 })
  const isWindows = process.platform === 'win32'
  const socketPath = isWindows
    ? `\\\\.\\pipe\\gugu-askpass-${crypto.randomBytes(8).toString('hex')}`
    : path.join(options.dir, 'askpass.sock')
  const wrapperPath = path.join(options.dir, isWindows ? 'askpass.cmd' : 'askpass.sh')
  if (isWindows) {
    fs.writeFileSync(wrapperPath, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%GUGU_ASKPASS_NODE%" "%GUGU_ASKPASS_JS%" %*\r\n`)
  } else {
    fs.writeFileSync(
      wrapperPath,
      '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GUGU_ASKPASS_NODE" "$GUGU_ASKPASS_JS" "$@"\n',
      { mode: 0o700 },
    )
  }

  const server = net.createServer((socket) => {
    let buffered = ''
    let answered = false
    const gone = new AbortController()
    const reply = (value: string | null) => {
      if (answered) return
      answered = true
      if (!socket.destroyed) socket.end(JSON.stringify(value === null ? { ok: false } : { ok: true, value }))
    }
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (!answered) gone.abort()
    })
    socket.on('data', (chunk) => {
      buffered += String(chunk)
      const newline = buffered.indexOf('\n')
      if (newline < 0) {
        if (buffered.length > 64 * 1024) socket.destroy()
        return
      }
      let request: { token?: unknown; prompt?: unknown; mode?: unknown }
      try {
        request = JSON.parse(buffered.slice(0, newline))
      } catch {
        socket.destroy()
        return
      }
      const given = Buffer.from(String(request.token ?? ''))
      const expected = Buffer.from(token)
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        socket.destroy()
        return
      }
      options
        .handler({
          prompt: typeof request.prompt === 'string' ? request.prompt : '',
          mode: typeof request.mode === 'string' ? request.mode : '',
          signal: gone.signal,
        })
        .then(reply, () => reply(null))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })

  return {
    env: {
      SSH_ASKPASS: wrapperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      // OpenSSH 8.4 之前没有 SSH_ASKPASS_REQUIRE:没有终端、且有 DISPLAY 时才用 askpass。
      DISPLAY: process.env.DISPLAY || 'gugu:0',
      GUGU_ASKPASS_NODE: options.nodeExecutable,
      GUGU_ASKPASS_JS: jsPath,
      GUGU_ASKPASS_SOCKET: socketPath,
      GUGU_ASKPASS_TOKEN: token,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
