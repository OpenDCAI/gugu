/**
 * 服务器上没有系统 CA 证书时(Docker 的 ubuntu 基础镜像、部分精简系统都不带 ca-certificates),
 * 咕咕 server 拉起的子进程 —— 装 agent 的 mise、agent 自己 —— 连 HTTPS 会当场失败:
 * `No CA certificates were loaded from the system`(#6264 在干净容器里实测)。
 *
 * 「服务器上不需要事先装任何东西」:这里用 Node 自带的根证书写一份 PEM,只在**系统一份都没有**时
 * 通过 SSL_CERT_FILE 指给子进程。系统有证书就完全不碰(企业自签根证书这类只在系统那份里)。
 */
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'

const SYSTEM_CA_FILES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu / Alpine
  '/etc/pki/tls/certs/ca-bundle.crt', // RHEL / Fedora
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL 7+
  '/etc/ssl/cert.pem', // macOS / Alpine
]

export function ensureCaBundleForChildren(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SSL_CERT_FILE || env.SSL_CERT_DIR) return null
  if (SYSTEM_CA_FILES.some((file) => fs.existsSync(file))) return null
  const bundle = path.join(dataDir, 'ca-bundle.pem')
  const wanted = `${tls.rootCertificates.join('\n')}\n`
  // #6264 磁盘满时每次启动都「截断再写」会把证书文件写坏、再抛异常让守护进程秒退(systemd 每 3 秒重来一次)。
  // 内容没变就不写;要写就先写临时文件再改名 —— 写不进去时旧的那份还完好,照样能用。
  let current: string | null = null
  try {
    current = fs.readFileSync(bundle, 'utf8')
  } catch {
    current = null
  }
  if (current !== wanted) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${bundle}.${process.pid}.tmp`
      fs.writeFileSync(tmp, wanted)
      fs.renameSync(tmp, bundle)
    } catch {
      fs.rmSync(`${bundle}.${process.pid}.tmp`, { force: true })
      if (current === null) return null
    }
  }
  env.SSL_CERT_FILE = bundle
  return bundle
}
