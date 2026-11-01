#!/usr/bin/env node
// 打咕咕 server 的安装包(product spec 第 1 条:一行命令装好,服务器上不需要事先装任何东西)。
//
// 产物:release/server/gugu-server-<version>-<os>-<arch>.tar.gz + 同名 .sha256,包内布局:
//   bin/gugu-server        启动器(sh):用包里自带的 node 跑 app/dist-electron/server.js
//   node/                  官方 Node 二进制(与仓库钉的版本一致)
//   app/dist-electron/     主进程构建产物 —— 与桌面版**同一次构建**的 main + server 入口(见 product-build-entries.mts)
//   app/node_modules/      主进程构建里 external 的那几个包,按 **Node 的 ABI** 装(桌面那份是 Electron ABI,不能混用);
//                          外加插件按路径现解析的 ACP 适配器(claude / codex / pi),打上与桌面同一份 pnpm 补丁
//                          (见 scripts/gugu-server/runtime-packages.mts)
//   app/mise-bundle/       agent 依赖安装器(与桌面同一份)
//   app/tmux-bundle/tmux   tmux 官方组织出的静态构建(tmux/tmux-builds),终端会话跨 server 重启靠它;
//                          放在这里,main.ts 的 @@@spawn-tmux-bin 按 app 路径自己找到,不用另接线
//   app/apps/desktop/preinstalled-apps/  预装 App,与桌面同一份,一个不挑(server 就是没窗口的桌面);server 上
//                          isPackaged=false,preinstalled-apps.ts 按 app 路径解析到这里,同样不用另接线
//   version                版本号(升级时比较用)
//
// ⚠️ 只能在目标平台上打本平台的包:原生模块的预编译件按**当前机器**的平台/架构下载。
//    CI 按平台矩阵各打各的(见 .github/workflows)。
//
// 用法:node scripts/build/build-gugu-server.mjs            (先确保主进程已构建:dist-electron/server.js 存在)
//      GUGU_SERVER_SKIP_NODE_DOWNLOAD=1 …            (本机调试:用当前 node 代替下载)
//      GUGU_SERVER_NODE_PREFIX=/usr/local …           (CI:从官方 node 镜像的安装前缀取,不下载;版本必须等于 .node-version)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADAPTER_PACKAGES,
  assertRuntimeSpecifiersResolve,
  externalDependencySpec,
  isExcludedNativePackage,
  parsePatchedDependencies,
  RUNTIME_PACKAGES,
} from '../gugu-server/runtime-packages.mts'
import { defaultMiseCacheDir, obtainMiseArchive } from './mise-archive-cache.mts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env.GUGU_SERVER_VERSION || rootPackage.version
const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim()
const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
if (!osName) throw new Error(`咕咕 server 只支持 Linux / macOS,当前平台是 ${process.platform}`)
const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
if (!arch) throw new Error(`不支持的架构:${process.arch}`)
const name = `gugu-server-${version}-${osName}-${arch}`
const releaseDir = join(root, 'release', 'server')
const stage = join(releaseDir, name)

// GUGU_SERVER_DIST_ELECTRON:主进程构建产物放在别处时指过去(本机调试时开发实例也在写 dist-electron)。
const distElectron = process.env.GUGU_SERVER_DIST_ELECTRON ?? join(root, 'apps', 'desktop', 'dist-electron')
if (!existsSync(join(distElectron, 'server.js'))) {
  throw new Error('找不到 apps/desktop/dist-electron/server.js —— 先构建主进程(pnpm build:app 的第二阶段)')
}

// GUGU_SERVER_NODE_PREFIX:一份官方 Node 发行包解开后的安装前缀(bin/node + LICENSE),包里的 node 从这里取。
// CI 的两个构建容器都是官方 node:<.node-version>-bookworm 镜像,/usr/local 就是镜像构建时按 SHASUMS256 校验过、
// 原样解开的那份官方包 ⇒ 直接取,❌ 再从 nodejs.org 现下(容器直连涓流,两个架构各 8~9 分钟)。
// 版本不等于 .node-version 就停 —— 在干任何活之前核,❌ 静默打进另一个版本的 node。
const nodePrefix = process.env.GUGU_SERVER_NODE_PREFIX
const prefixNode = nodePrefix ? join(nodePrefix, 'bin', 'node') : null
if (prefixNode) {
  const got = execFileSync(prefixNode, ['--version'], { encoding: 'utf8' }).trim()
  if (got !== `v${nodeVersion}`) throw new Error(`${prefixNode} 是 ${got},.node-version 钉的是 v${nodeVersion} —— 拒绝把别的版本打进包`)
}

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...options })
}

// external 的包及其版本以**仓库锁定的版本**为准,❌ 另写一份版本号。
// 另一个架构的容器里没有装好的 node_modules(CI 在 x64 容器里构建,arm64 容器只拿到产物):
// 那边用 GUGU_SERVER_EXTERNALS 指向这边写下的 externals.json,两个架构用的是同一组版本(别名依赖也原样带过去)。
// 装哪些包见 runtime-packages.mts:原生模块 + ACP 适配器。
const EXTERNAL_PACKAGES = RUNTIME_PACKAGES
const externalVersions = process.env.GUGU_SERVER_EXTERNALS
  ? Object.fromEntries(
      Object.entries(JSON.parse(readFileSync(process.env.GUGU_SERVER_EXTERNALS, 'utf8'))).map(([pkg, spec]) => [
        pkg,
        externalDependencySpec(pkg, rootPackage.dependencies, spec),
      ]),
    )
  : Object.fromEntries(
      EXTERNAL_PACKAGES.map((pkg) => [
        pkg,
        externalDependencySpec(pkg, rootPackage.dependencies, JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version),
      ]),
    )
for (const pkg of EXTERNAL_PACKAGES) {
  if (typeof externalVersions[pkg] !== 'string') throw new Error(`缺 ${pkg} 的锁定版本`)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'app'), { recursive: true })
writeFileSync(join(releaseDir, 'externals.json'), `${JSON.stringify(externalVersions, null, 2)}\n`)

console.log(`[server-bundle] ${name}`)
cpSync(distElectron, join(stage, 'app', 'dist-electron'), { recursive: true })

// 预装 App,连同出包闸:每一个都得在包里。少了它们,server 上就一个预装 App 都没有 —— agent 连群文件夹的工具都拿不到。
{
  const shipped = join(root, 'apps', 'desktop', 'preinstalled-apps')
  const packed = join(stage, 'app', 'apps', 'desktop', 'preinstalled-apps')
  cpSync(shipped, packed, { recursive: true })
  const ids = readdirSync(shipped, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
  const missing = ids.filter((id) => !existsSync(join(packed, id, 'manifest.json')))
  if (ids.length === 0 || missing.length > 0) throw new Error(`包里缺预装 App:${missing.join(', ') || '一个都没有'}`)
  console.log(`[server-bundle] preinstalled Apps: ${ids.join(', ')}`)
}
writeFileSync(
  join(stage, 'app', 'package.json'),
  JSON.stringify({ name: 'gugu-server', version, private: true, dependencies: externalVersions }, null, 2),
)
// 按 Node ABI 装原生模块:在包目录里对着上面那份 package.json 装一次,预编译件由各包自己的 install 脚本按本机平台取。
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: join(stage, 'app') })

// 桌面包里这些包由 pnpm 装、pnpm-workspace.yaml 的 patchedDependencies 自动打上补丁;npm 不认那一段,
// 这里照同一份补丁文件打一遍 —— 同一个版本号,桌面和 server 跑的必须是同一份代码。
// 版本对不上就停:补丁是钉在某个版本上的,硬打到别的版本上只会得到一份谁都没测过的东西。
// 只打适配器的。#6394 起桌面这边已经没有任何依赖补丁(claude、pi 换成咕咕维护的构建,node-pty 那份删了),
// 这一段眼下什么都不打;留着是为了万一再出现适配器补丁时,桌面和 server 仍是同一份代码。
{
  const appModules = join(stage, 'app', 'node_modules')
  const patched = parsePatchedDependencies(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  for (const { name, version, patch } of patched.filter((entry) => ADAPTER_PACKAGES.includes(entry.name))) {
    const pkgDir = join(appModules, name)
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error(`要打补丁的 ${name} 没装进包里`)
    const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
    if (installed !== version) throw new Error(`${name} 装上的是 ${installed},补丁钉的是 ${version}(${patch})`)
    console.log(`[server-bundle] patch ${name}@${version}`)
    run('patch', ['-p1', '--forward', '--batch', '--no-backup-if-mismatch', '-d', pkgDir, '-i', join(root, patch)])
  }

  // 适配器依赖树带进来的平台原生二进制包(claude / codex 各 200MB+):与桌面包同样剔掉,运行时从不执行。
  const sweep = (modulesDir) => {
    if (!existsSync(modulesDir)) return
    for (const entry of readdirSync(modulesDir)) {
      const scopes = entry.startsWith('@') ? readdirSync(join(modulesDir, entry)).map((n) => `${entry}/${n}`) : [entry]
      for (const name of scopes) {
        if (isExcludedNativePackage(name)) {
          console.log(`[server-bundle] drop ${name}`)
          rmSync(join(modulesDir, name), { recursive: true, force: true })
          continue
        }
        sweep(join(modulesDir, name, 'node_modules'))
      }
    }
  }
  sweep(appModules)

  // 出包闸:dist-electron 里每一个按路径现解析的模块,都必须落在包自己的 node_modules 里。
  const resolved = assertRuntimeSpecifiersResolve(join(stage, 'app'))
  console.log(`[server-bundle] runtime modules resolve: ${resolved.join(', ')}`)
}

run(process.execPath, [join(root, 'scripts', 'build', 'build-mise-bundle.mjs')], { cwd: root })
const miseOs = osName === 'darwin' ? 'mac' : 'linux'
cpSync(join(root, 'mise-bundle', `${miseOs}-${arch}`), join(stage, 'app', 'mise-bundle', `${miseOs}-${arch}`), { recursive: true })

// tmux:桌面 Linux 包是把构建机的 tmux 拷进去(动态链接 libevent 等,干净服务器上可能缺),
// server 要零依赖 → 用 tmux 官方组织的静态构建。版本与哈希钉死(tmux-release.json),❌ 跟 latest 走。
// 归档走与 mise 同一个内容寻址缓存(<sha256>/<文件名>):CI 上由宿主预取(seed-mise-cache.sh --pin …)、
// 只读挂进容器,命中即不联网;未命中时只读挂载让写入当场失败 —— ❌ 在容器里直连 GitHub 涓流。
{
  const TMUX = JSON.parse(readFileSync(join(root, 'scripts', 'gugu-server', 'tmux-release.json'), 'utf8'))
  const pin = TMUX.assets[`${osName}-${arch}`]
  if (!pin) throw new Error(`tmux-release.json 里没有 ${osName}-${arch}`)
  const archive = obtainMiseArchive({
    cacheDir: defaultMiseCacheDir(),
    downloadBase: 'https://github.com/tmux/tmux-builds/releases/download',
    version: TMUX.version,
    asset: pin.asset,
    sha256: pin.sha256,
  })
  const tmuxDir = join(stage, 'app', 'tmux-bundle')
  mkdirSync(tmuxDir, { recursive: true })
  run('tar', ['-xzf', archive, '-C', tmuxDir])
  if (!existsSync(join(tmuxDir, 'tmux'))) throw new Error(`${pin.asset} 里没有 tmux 可执行文件`)
  chmodSync(join(tmuxDir, 'tmux'), 0o755)
}

// 远程隧道的中转客户端 frpc(版本与哈希钉在 scripts/frpc-release.json):账号进程用它把本机的 SSH 端点挂到中转上,
// 别的电脑经它开这台机器的终端 / 浏览器 / 端口。放在 app/frpc-bundle/frpc,frpc-runner.ts 按应用路径找到。
run(process.execPath, [join(root, 'scripts', 'build', 'build-frpc-bundle.mjs'), '--platform', osName, '--arch', arch], { cwd: root })
{
  const frpcDir = join(stage, 'app', 'frpc-bundle')
  mkdirSync(frpcDir, { recursive: true })
  cpSync(join(root, 'frpc-bundle', `${miseOs}-${arch}`, 'frpc'), join(frpcDir, 'frpc'))
  cpSync(join(root, 'frpc-bundle', `${miseOs}-${arch}`, 'LICENSE'), join(frpcDir, 'LICENSE'))
}

// 自带 Node:服务器上不要求装任何东西。
const nodeDir = join(stage, 'node')
if (process.env.GUGU_SERVER_SKIP_NODE_DOWNLOAD === '1') {
  mkdirSync(join(nodeDir, 'bin'), { recursive: true })
  cpSync(process.execPath, join(nodeDir, 'bin', 'node'))
} else if (nodePrefix) {
  mkdirSync(join(nodeDir, 'bin'), { recursive: true })
  cpSync(prefixNode, join(nodeDir, 'bin', 'node'))
  cpSync(join(nodePrefix, 'LICENSE'), join(nodeDir, 'LICENSE'))
} else {
  const nodeName = `node-v${nodeVersion}-${osName}-${arch}`
  const archive = join(releaseDir, `${nodeName}.tar.xz`)
  if (!existsSync(archive)) {
    run('curl', ['-fsSL', '--retry', '3', '-o', archive, `https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.xz`])
  }
  mkdirSync(nodeDir, { recursive: true })
  run('tar', ['-xJf', archive, '-C', nodeDir, '--strip-components=1', `${nodeName}/bin/node`, `${nodeName}/LICENSE`])
}

mkdirSync(join(stage, 'bin'), { recursive: true })
const launcher = `#!/bin/sh
# 咕咕 server ${version} 启动器。跟随软链找到安装目录,用包里自带的 node 跑。
set -e
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
dir="$(cd "$(dirname "$self")/.." && pwd -P)"
export GUGU_TASK_HOST_APP_PATH="$dir/app"
export GUGU_TASK_HOST_VERSION="${version}"
exec "$dir/node/bin/node" "$dir/app/dist-electron/server.js" "$@"
`
writeFileSync(join(stage, 'bin', 'gugu-server'), launcher)
chmodSync(join(stage, 'bin', 'gugu-server'), 0o755)
writeFileSync(join(stage, 'version'), `${version}\n`)

// 权限归一:包里的文件权限不能跟着构建机走(实测 Docker Desktop 挂载目录里拷出来的文件会变成 --w-------,
// 换个用户解包就 EACCES)。一律 所有者可读写、其他人可读,目录与可执行文件加 x。
run('chmod', ['-R', 'u+rwX,go+rX,go-w', stage])
// 上面的 X 只保留「本来就可执行」的 x 位 —— 而原件的 x 位在复制途中就可能已经丢了(实测 mise 丢了 x,
// 咕咕 server 上装 agent 当场 `spawn …/mise EACCES`)。所以要跑的每个文件点名给 755,再逐个断言。
const executables = [
  join(stage, 'bin', 'gugu-server'),
  join(stage, 'node', 'bin', 'node'),
  join(stage, 'app', 'tmux-bundle', 'tmux'),
  join(stage, 'app', 'mise-bundle', `${miseOs}-${arch}`, 'mise', 'bin', 'mise'),
  join(stage, 'app', 'frpc-bundle', 'frpc'),
  join(stage, 'app', 'node_modules', 'node-pty', 'prebuilds', `${osName}-${arch}`, 'spawn-helper'),
].filter((file, index) => index < 5 || existsSync(file))
for (const file of executables) {
  if (!existsSync(file)) throw new Error(`包里缺可执行文件:${file}`)
  chmodSync(file, 0o755)
  if ((statSync(file).mode & 0o111) !== 0o111) throw new Error(`没能给 ${file} 加上可执行权限`)
}

const tarball = join(releaseDir, `${name}.tar.gz`)
rmSync(tarball, { force: true })
run('tar', ['-czf', tarball, '-C', releaseDir, name])
const hash = createHash('sha256')
await new Promise((resolve, reject) => {
  createReadStream(tarball).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject)
})
const sha256 = hash.digest('hex')
writeFileSync(`${tarball}.sha256`, `${sha256}  ${name}.tar.gz\n`)
console.log(`[server-bundle] ${tarball}\n[server-bundle] sha256 ${sha256}`)
