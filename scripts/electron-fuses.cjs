// @@@electron-fuses (#7195) — 装机包的 Electron Fuses:翻在 Electron 二进制里的编译期开关,运行时改不了。
//
// electron-builder 在 afterPack 之后、签名之前翻它们(app-builder-lib platformPackager.doAddElectronFuses
// 注释:「the fuses MUST be flipped right before signing」)。这里只显式写**翻了的**几项,其余一律保持
// Electron 默认。**没翻的每一项都有原因**,不是漏的 —— 后来人想补之前先读:
//
//   · runAsNode:false          ❌ ELECTRON_RUN_AS_NODE 在本产品里承重(engine-downloader 跑随包 npm、
//                                 session-host-entry、ssh-askpass、extension-session-mcp,另见 devtools-lock.ts)。
//   · enableNodeOptionsEnvironmentVariable:false  ❌ 这个 fuse 同时管 NODE_EXTRA_CA_CERTS:经 Electron 当 node
//                                 跑的 npm 会静默忽略用户的企业/校园代理证书,引擎下载在那类网络里挂掉;
//                                 而 runAsNode 必须开着,关它本来也防不住什么。
//   · onlyLoadAppFromAsar / enableEmbeddedAsarIntegrityValidation  ❌ 前提是 asar,而 asar 是 #2299 有意关的
//                                 (electron-builder.cjs @@@kill-asar)。asar:false 时打开 onlyLoadAppFromAsar
//                                 = 找不到 app 代码,装机包直接起不来。
//   · grantFileProtocolExtraPrivileges:false  ❌ extension-look-picture.ts 用 loadFile(file://)载入图库页。
//   · enableCookieEncryption   不动:单向迁移且牵涉系统钥匙串,不是反逆向项,需要 owner 另议。
//
// 这不是安全边界(runAsNode 开着,拿到装机包的人照样能用同一个二进制跑任意 JS;asar 关着,代码是明文)。
// 它只关掉一条廉价的动态内省路径,真防线仍在服务端。
'use strict'

/**
 * @param {{ tier: string }} input  GUGU_TIER(production / beta / acceptance-*)
 * @returns {import('app-builder-lib').FuseOptionsV1}
 */
function resolveElectronFuses({ tier }) {
  return {
    // 只在 .app 路径上生效(@electron/fuses 自己判):翻 fuse 改了二进制,arm64 的 ad-hoc 签名随之失效,
    // 本地未签名包会被系统直接杀掉。正式签名在它之后,会整个覆盖掉这一次 ad-hoc。
    resetAdHocDarwinSignature: true,
    runAsNode: true,
    // 关掉 `--inspect` 与 SIGUSR1 唤起的主进程 inspector。devtools-lock 只锁了 DevTools 与 CDP 端口,
    // 对一个正在跑的主进程发 SIGUSR1 再挂 inspector 这条路它够不着。
    // 只正式版关:beta / 验收包保留,dogfood 排障要用(同 devtools-lock「只锁正式版」)。
    //
    // 实测(Electron 44,macOS arm64,用本函数的真实配置翻过的 Electron 副本,未翻副本作阳性对照):
    //   · 主进程 `--inspect=0` 与 SIGUSR1:正式版都挂不上 inspector,未翻 / beta 都挂得上。
    //   · ⚠️ 副作用:正式版收到 SIGUSR1 会被默认动作**直接杀掉**(signal=SIGUSR1),而不是被忽略。
    //     咕咕代码里没有人发 SIGUSR1;同用户本来就能 SIGKILL,所以不是新能力,但别拿 SIGUSR1 当「重载日志」类信号用。
    //   · 管不到 ELECTRON_RUN_AS_NODE 模式:拿同一个二进制当 node 跑,`--inspect` 照样挂得上
    //     (runAsNode 必须开着,见上)。所以它只挡「调试真正的 Electron 主进程」,不挡「当 node 用」。
    enableNodeCliInspectArguments: tier !== 'production',
  }
}

module.exports = { resolveElectronFuses }
