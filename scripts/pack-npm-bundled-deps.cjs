// @@@npm-bundled-deps (#6552) — 包里的 npm 要带上它自己的依赖。
//
// engine-downloader 用 Electron 内嵌的 node 跑随包的 npm(`resolveBundledNpmInvocation`),配对的 claude 桥接
// 与按需下载的引擎都靠它装。npm 自己的依赖是 `bundleDependencies`:发布时就躺在 `npm/node_modules/` 里,
// 不在依赖图上;而 electron-builder 的 NodeModuleCopyHelper 硬排 `node_modules` 目录名、不 walk 进去
// (见 electron-builder.cjs 的 @@@thin-claude-native)⇒ 这一整棵被丢掉,包里的 npm 一跑就
// `Cannot find module 'graceful-fs'`。Windows Beta 实测:每次起 claude 聊天会话下载配对桥接都失败,
// 永远退回随包那份(那条日志一直在报,但只是 warn)。
//
// ⇒ afterPack 把它补回去,并按 npm 自己声明的 bundleDependencies 逐个核:少一个就让打包失败,
// ❌ 不让一个跑不起来的 npm 进安装包。
const fs = require('node:fs')
const path = require('node:path')

/**
 * @param {{ appDir: string, repoRoot: string }} opts
 *   appDir   —— 打出来的 app 目录(asar 关着:`<resources>/app`)
 *   repoRoot —— 从哪里解析源 npm(根 dependencies 里的那一份)
 * @returns {number} 核过的 bundled 依赖个数
 */
function packNpmBundledDependencies({ appDir, repoRoot }) {
  const packedNpm = path.join(appDir, 'node_modules', 'npm')
  if (!fs.existsSync(path.join(packedNpm, 'package.json'))) {
    throw new Error(`[npm-bundled-deps] 包里没有 npm(${packedNpm})—— npm 必须留在根 dependencies`)
  }
  const sourceNpm = path.dirname(require.resolve('npm/package.json', { paths: [repoRoot] }))
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceNpm, 'package.json'), 'utf8'))
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies ?? []
  const sourceModules = path.join(sourceNpm, 'node_modules')
  if (bundled.length > 0 && !fs.existsSync(sourceModules)) {
    throw new Error(`[npm-bundled-deps] 源 npm 没有 node_modules(${sourceModules})—— 安装不完整`)
  }
  if (fs.existsSync(sourceModules)) {
    // This afterPack copy runs after electron-builder's source-map exclusion.
    fs.cpSync(sourceModules, path.join(packedNpm, 'node_modules'), {
      recursive: true,
      dereference: true,
      filter: (source) => !source.endsWith('.map'),
    })
  }
  const missing = bundled.filter(
    (name) => !fs.existsSync(path.join(packedNpm, 'node_modules', name, 'package.json'))
  )
  if (missing.length > 0) {
    throw new Error(`[npm-bundled-deps] 包里的 npm 缺 bundled 依赖:${missing.join(', ')}`)
  }
  return bundled.length
}

/** electron-builder 的 afterPack 上下文 → asar 关着时 app 目录的位置。 */
function packedAppDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app',
    )
  }
  return path.join(context.appOutDir, 'resources', 'app')
}

module.exports = { packNpmBundledDependencies, packedAppDir }
