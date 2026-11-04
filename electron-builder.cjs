// @@@tier-build - single source of truth for per-tier packaging. GUGU_TIER (default 'production')
// selects appId / productName / update channel / artifact name. Distinct appId is what lets prod and
// beta coexist on one machine: each gets its own single-instance lock, userData, and dock identity.
// The desktop main bundle reads the SAME GUGU_TIER (via vite define) to pick its default home
// (~/.gugu vs ~/.gugu-beta); core's resolveGuguHome is untouched so the standalone CLI default stays ~/.gugu.
const { guguLinkScheme } = require('./packages/core/src/shared/ui/linkScheme.mjs')
const tier = process.env.GUGU_TIER || 'production'
const buildDistribution = process.env.GUGU_BUILD_DISTRIBUTION || 'local'
if (buildDistribution !== 'local' && buildDistribution !== 'published') {
  throw new Error(
    `Unknown GUGU_BUILD_DISTRIBUTION '${buildDistribution}' — expected local or published`
  )
}

// @@@tier-feed - feedUrl is baked into app-update.yml at package time. Since #5737 每个 tier 烧的是**自己那条
// 通道**的 feed,运行期不再覆盖(main.ts @@@5737):正式版追正式版、Beta 追 Beta。跨通道升级等于拿另一个
// 应用的包去原地换,Squirrel 的签名判据必不过。A tier's `channel` names the feed file electron-builder emits
// (latest.yml / beta.yml …);Mac 另有 `macChannel`(@@@7394,nextmind-mac.yml / nextmind-beta-mac.yml)——
// 这些都会被发布;acceptance-<tag> 的那份没人发也没人读,因为验收包不自动更新。
// Both sides read updateFeeds.json so the URL cannot drift apart.
const FEEDS = require('./apps/desktop/electron/updateFeeds.json')

// @@@build-version (#4703) - a dogfood prerelease version is a BUILD PARAMETER, not a source edit.
// GUGU_BUILD_VERSION overrides the version inside the bundled app (app.getVersion(), the `${version}` in
// artifactName) while the checkout's package.json stays untouched, so build provenance and the artifact
// ledger both record the real, clean commit tree. vite.config.mts reads the same variable for the renderer's
// __APP_VERSION__ so About and the dmg name cannot disagree. Unset → package.json version, as always.
const buildVersion = process.env.GUGU_BUILD_VERSION
if (buildVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildVersion)) {
  throw new Error(`GUGU_BUILD_VERSION '${buildVersion}' is not x.y.z or x.y.z-prerelease`)
}

// @@@7394 Mac 的标识单独换:`com.gugu.app` 被别的 Apple 团队注册了,我们拿不到它的描述文件,受限权限
// (Touch ID 通行密钥要的钥匙串组,#7344)就开不了。所以 Mac 用 macAppId(本团队名下注册的),Windows /
// Linux 仍用 appId —— NSIS 的 GUID 与 AUMID 都从 appId 推,动了会让 Windows 用户装出第二个咕咕。
// 换了标识就是另一个应用,Squirrel 原地换包必过不了旧包的签名判据,所以新标识的包住进**另一份清单**
// (macChannel → <macChannel>-mac.yml);原来那份(channel → latest-mac.yml / beta-mac.yml)照发同一版本、
// 但只列 dmg,老包就走它们 v0.2.17 起就有的 dmg 换装那条路(scripts/normalize-mac-feed.cjs @@@7394)。
const TIERS = {
  production: {
    appId: 'com.gugu.app',
    macAppId: 'nextmind.gugu',
    macChannel: 'nextmind',
    productName: '咕咕',
    channel: 'latest',
    artifactPrefix: 'gugu',
    nsisInclude: 'build-resources/nsis/production-installer.nsh',
    feedUrl: FEEDS.stable,
    // @@@5576 有 feed 的通道才出 zip:它是 Squirrel.Mac 自动更新唯一能下的形态。
    // @@@5737 起 beta 也有自己的 feed,所以它也出。acceptance 仍然不出 —— 它谁也不追。
    macZip: true
  },
  beta: {
    appId: 'com.gugu.app.beta',
    macAppId: 'nextmind.gugu.beta',
    macChannel: 'nextmind-beta',
    productName: '咕咕 Beta',
    channel: 'beta',
    artifactPrefix: 'gugu-beta',
    nsisInclude: 'build-resources/nsis/beta-install-dir.nsh',
    feedUrl: FEEDS.beta,
    macZip: true
  }
}

// @@@acceptance-tier (#3875) - owner 验收包:`GUGU_TIER=acceptance-<tag>`(tag 任意小写,如 local / staging)。
// 每个 tag 一个独立 appId / productName / userData(main.ts 按 tier 派生 ~/.gugu-acceptance-<tag>),
// 于是「连本机库的包」「连预发的包」与已装的正式版、Beta 可以同机并存、各自登录,互不抢单实例锁。
// 不进任何 CD 道:没有 workflow 选它。@@@5737 起它**不自动更新**(没有通道) —— 烧哪个 feed 都没人读,
// 留 stable 只为让 electron-builder 有个合法值。
const acceptance = /^acceptance(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec(tier)
if (acceptance && !TIERS[tier]) {
  TIERS[tier] = {
    appId: `com.gugu.app.${tier}`,
    productName: `咕咕 验收${acceptance[1] ? ` ${acceptance[1]}` : ''}`,
    channel: tier,
    artifactPrefix: `gugu-${tier}`,
    nsisInclude: 'build-resources/nsis/beta-install-dir.nsh',
    feedUrl: FEEDS.stable
  }
}
const t = TIERS[tier]
if (!t) {
  throw new Error(`Unknown GUGU_TIER '${tier}' — expected one of: ${Object.keys(TIERS).join(', ')} or acceptance[-<tag>]`)
}

// @@@bundle-tmux - ship the vendored tmux (scripts/build/build-tmux-bundle.mjs → tmux-bundle/) so agent
// hosting defaults to tmux without a system tmux. Gated on existence so a build machine without tmux
// (CI, where build:tmux skips) still packages; desktop main sets GUGU_TMUX_BIN only when it's present.
// Windows ships psmux's tmux-compatible entrypoint from scripts/build-psmux-bundle.mjs instead of the
// POSIX tmux bundle, so a macOS cross-build never drops a Mach-O tmux into the Windows installer.
const fs = require('node:fs')
const path = require('node:path')
const { packNpmBundledDependencies, packedAppDir } = require('./scripts/build/pack-npm-bundled-deps.cjs')
const { resolveElectronFuses } = require('./scripts/build/electron-fuses.cjs')
const PACKED_APP_ENTRIES = new Set(['apps', 'build-resources', 'dist', 'node_modules', 'package.json'])
const excludeClaudeNative = '!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**'
const targetArgs = new Set(process.argv.slice(2))
const isWindowsOnlyBuild =
  (targetArgs.has('--win') || targetArgs.has('-w')) &&
  !(targetArgs.has('--mac') || targetArgs.has('-m') || targetArgs.has('--linux') || targetArgs.has('-l'))
const extraResources = [{ from: 'mise-bundle/${os}-${arch}', to: 'mise-bundle', filter: ['**/*'] }]
// 远程隧道的中转客户端 frpc(scripts/build/build-frpc-bundle.mjs,版本与哈希钉在 scripts/frpc-release.json):
// 打包前由下面的 beforePack 按目标平台取好,运行时在 Resources/frpc-bundle/ 找(electron/server/frpc-runner.ts)。
extraResources.push({ from: 'frpc-bundle/${os}-${arch}', to: 'frpc-bundle', filter: ['**/*', '!release.json'] })
if (!isWindowsOnlyBuild && fs.existsSync(path.join(__dirname, 'tmux-bundle', 'tmux'))) {
  extraResources.push({ from: 'tmux-bundle', to: 'tmux-bundle', filter: ['**/*'] })
}
if (isWindowsOnlyBuild && fs.existsSync(path.join(__dirname, 'psmux-bundle', 'tmux.exe'))) {
  extraResources.push({ from: 'psmux-bundle', to: 'psmux-bundle', filter: ['**/*'] })
}
// L3 preinstalled Apps (工作区 first): apps/desktop/preinstalled-apps/<id>/ ships as Resources/preinstalled-apps/,
// and gugu installs it from there at every start (electron/session/main/core/extensions/preinstalled-apps.ts).
extraResources.push({ from: 'apps/desktop/preinstalled-apps', to: 'preinstalled-apps', filter: ['**/*', '!README.md'] })
// The optional legacy full bundle contains only codex-acp. Claude's JavaScript bridge is a
// production dependency; its CLI always comes from the host's harness installation.
if (
  fs.existsSync(
    path.join(__dirname, 'acp-bundle', 'node_modules', '@zed-industries', 'codex-acp', 'bin', 'codex-acp.js')
  )
) {
  extraResources.push({
    from: 'acp-bundle', to: 'acp',
    filter: ['**/*', excludeClaudeNative],
  })
}

// @@@mac-signing - macOS 签名有两档,由**凭据在不在环境里**决定,不由分支/tier 决定:
//   正式档:CSC_LINK(base64 的 Developer ID Application .p12)或 CSC_NAME(钥匙串里的身份名)
//           → electron-builder 走原生 codesign,hardened runtime + entitlements,签完交
//           notarytool 公证并 staple 票据。这是「用户双击就能开、Gatekeeper 不拦」的唯一档。
//   ad-hoc 档:两个都没有 → 退回 scripts/release/ad-hoc-mac-sign.cjs(codesign -s -)。本地开发机、
//           没配凭据的 CI 槽照样出得了包,只是装的人要右键打开。
// ❗ 不设第三档:有证书却缺公证凭据时**直接抛**,不静默降级成「签了但没公证」——那种包
//    在用户机器上和 ad-hoc 一样被 Gatekeeper 拦,却看起来像正式包,是最坏的一种出厂物(fail loud)。
const macIdentitySource = process.env.CSC_LINK ? 'CSC_LINK' : process.env.CSC_NAME ? 'CSC_NAME' : null
if (macIdentitySource) {
  // electron-builder 26.x:`mac.notarize` 只是**布尔开关**(24.x 的 `{teamId}` 对象形式已被移除,
  // 传对象会在 schema 校验就挂)。公证真正被激活,靠的是下面这三个环境变量 ——
  // 缺了它们 notarizeIfProvided() 只打一行 warn「notarize options were unable to be generated」
  // 就跳过,构建照样绿(out/mac/MacTargetHelper.js)。所以判据必须是它们,不是 notarize 字段本身。
  const missing = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new Error(
      `mac 签名凭据(${macIdentitySource})在,但公证凭据缺 ${missing.join('/')} —— 拒绝出「签了不公证」的半成品包。` +
        'APPLE_API_KEY 要的是 .p8 **文件路径**(不是内容),三个齐全才会真的送公证;' +
        '或把 CSC_LINK/CSC_NAME 一并撤掉退回 ad-hoc 档。'
    )
  }
  // APPLE_TEAM_ID 在 API-key 这条公证路径上不是 electron-builder 的必需项,但 CI 的出厂门
  // (scripts/verify-mac-signature.mjs)要拿它断言产物的 TeamIdentifier。缺了 = 出厂门无从判真伪。
  if (!process.env.APPLE_TEAM_ID) {
    throw new Error('mac 签名凭据在,但 APPLE_TEAM_ID 缺失 —— 出厂门无法断言产物签名主体,拒绝构建。')
  }
}
// electron-builder 的 findIdentity():CSC_IDENTITY_AUTO_DISCOVERY==='false' 且没有 CSC_NAME 时
// **直接返回 null 身份**,于是 CSC_LINK 导进临时 keychain 的证书根本不会被用上,只 warn 一句
// "skipped macOS application code signing" 就出一个没签名的 .app(codeSign/macCodeSign.js)。
// CD 里那行 'false' 是 ad-hoc 时代的遗产,和证书一起留着就是这个静默失败。宁可在这儿炸。
if (macIdentitySource === 'CSC_LINK' && process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
  throw new Error(
    'CSC_LINK 在,但 CSC_IDENTITY_AUTO_DISCOVERY=false —— electron-builder 会静默跳过签名,出没签名的包。' +
      '把 CSC_IDENTITY_AUTO_DISCOVERY 设成 true(或删掉这个变量),或改用 CSC_NAME 指名身份。'
  )
}
const macEntitlements = path.join(__dirname, 'apps', 'desktop', 'sign', 'entitlements.mac.plist')

// @@@7394 描述文件:GUGU_MAC_PROVISIONING_PROFILE = .provisionprofile 的**路径**(CD 从密钥落到 RUNNER_TEMP)。
// 有它,主程序才能声明受限权限(钥匙串组等);electron-builder 把它嵌成 Contents/embedded.provisionprofile。
// 三种组合都 fail loud:
//   · 有描述文件却没有 Developer ID 证书 —— ad-hoc 签名带不了受限权限,装上起不来;
//   · 有描述文件的 tier 没有本团队注册的 Mac 标识(验收包)—— 描述文件绑的是别的标识;
//   · 要发布的 Developer ID 包缺描述文件 —— 包能跑,但 Touch ID 通行密钥悄悄没了,是最难发现的一种。
const macProvisioningProfile = process.env.GUGU_MAC_PROVISIONING_PROFILE || null
if (macProvisioningProfile) {
  if (!macIdentitySource) {
    throw new Error('GUGU_MAC_PROVISIONING_PROFILE 在,但没有 Developer ID 签名凭据(CSC_LINK/CSC_NAME)—— ad-hoc 包带不了受限权限。')
  }
  if (!t.macAppId) {
    throw new Error(`tier '${tier}' 没有本团队注册的 Mac 标识,描述文件对不上它 —— 只有 production / beta 嵌描述文件。`)
  }
  if (!fs.existsSync(macProvisioningProfile)) {
    throw new Error(`GUGU_MAC_PROVISIONING_PROFILE 指向的文件不存在: ${macProvisioningProfile}`)
  }
} else if (macIdentitySource && buildDistribution === 'published' && t.macAppId) {
  throw new Error(
    `要发布的 ${tier} Mac 包签了 Developer ID 却没有描述文件(GUGU_MAC_PROVISIONING_PROFILE)—— ` +
      '包能跑,但钥匙串组没了、Touch ID 通行密钥用不了(#7344)。拒绝出这种包。'
  )
}

/**
 * 主程序的权限 = 公共那份 + 描述文件授权的三项。**只给主程序**:辅助进程(Helper、tmux、原生助手)没有自己的
 * 描述文件,声明受限权限会被系统当场杀掉,所以它们仍用 entitlementsInherit 那份公共的。
 * 钥匙串组取 `<团队>.<Mac 标识>`,外加 Touch ID 通行密钥专用的 `<团队>.<Mac 标识>.webauthn`(Electron 文档的
 * 惯例写法;运行期 macWebAuthn.ts 按同一规则从描述文件推出它)。描述文件允许 `<团队>.*`。
 */
function macMainEntitlements() {
  if (!macProvisioningProfile) return macEntitlements
  const teamId = process.env.APPLE_TEAM_ID
  const appIdentifier = `${teamId}.${t.macAppId}`
  const restricted = [
    '    <!-- @@@7394 描述文件授权的受限权限(由 electron-builder.cjs 按 tier 生成,❌ 手改) -->',
    `    <key>com.apple.application-identifier</key>\n    <string>${appIdentifier}</string>`,
    `    <key>com.apple.developer.team-identifier</key>\n    <string>${teamId}</string>`,
    `    <key>keychain-access-groups</key>\n    <array>\n      <string>${appIdentifier}</string>\n      <string>${appIdentifier}.webauthn</string>\n    </array>`,
  ].join('\n')
  const base = fs.readFileSync(macEntitlements, 'utf8')
  if (!base.includes('  </dict>\n</plist>')) throw new Error(`${macEntitlements} 的结尾变了,生成主程序权限的拼接点对不上`)
  const out = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gugu-entitlements-')), 'entitlements.main.plist')
  fs.writeFileSync(out, base.replace('  </dict>\n</plist>', `${restricted}\n  </dict>\n</plist>`))
  return out
}

const macSigning = macIdentitySource
  ? {
      sign: 'scripts/release/developer-id-mac-sign.cjs',
      // hardenedRuntime 在非 mas 构建下本就默认 true,显式写出来是为了让这段配置自解释。
      hardenedRuntime: true,
      // ❌ 别开 gatekeeperAssess:构建机(mac1)是 non-gui 会话,spctl 评估在那儿不可靠;
      //    真正的把关在 CI 的 scripts/verify-mac-signature.mjs 出厂门,那道门跑在产物上、判据明确。
      gatekeeperAssess: false,
      entitlements: macMainEntitlements(),
      entitlementsInherit: macEntitlements,
      ...(macProvisioningProfile ? { provisioningProfile: macProvisioningProfile } : {}),
      // 26.x 只接受布尔;凭据走 APPLE_API_KEY/_KEY_ID/_ISSUER(已在上面的守卫里断言齐全)。
      notarize: true
    }
  : {
      sign: 'scripts/release/ad-hoc-mac-sign.cjs',
      notarize: false
    }

module.exports = {
  appId: t.appId,
  productName: t.productName,
  // @@@tier-app-name - merge both name and productName into the bundled app package.json.
  // productName keeps app.getName()/userData tier-correct; name keeps one-click Windows NSIS installs
  // tier-correct because its default APP_FILENAME uses sanitized package name, not productName.
  // Without name, beta and production share %LOCALAPPDATA%\Programs\gugu and can run a stale app build.
  extraMetadata: {
    name: t.artifactPrefix,
    productName: t.productName,
    guguBuildDistribution: buildDistribution,
    ...(buildVersion ? { version: buildVersion } : {}),
  },
  directories: {
    buildResources: 'build-resources',
    output: 'release'
  },
  artifactName: t.artifactPrefix + '-${version}-${arch}.${ext}',
  // #6387 一条通道一个链接前缀(与 src/session/shared/extensions/link-scheme.ts 同一条规则):
  // 正式版与 Beta 同机并存,两家都认 gugu:// 时,系统把链接交给谁取决于谁最后启动过。
  protocols: [{ name: 'gugu', schemes: [guguLinkScheme({ tier, devLaunch: false })] }],
  // @@@native-abi-owner (#2282) - native ABI 的唯一 rebuild owner = 下方 beforePack 里的
  // @electron/rebuild(electron 44 ABI 149,按 context.arch 逐架构重建后再打该架构的包)。
  // electron-builder 自带的 npmRebuild 阶段在本仓不可用,必须关:#2274 把 node-pty/better-sqlite3/
  // @parcel/watcher 迁入 root prod deps 后该阶段首次激活(run 29900369519),它 shell `npm rebuild`——
  // npm 对 pnpm symlink 布局把 node-pty 当 linked package 跑其 `prepare`(tsc 连测试一起编译,发布
  // tarball 内必炸;npm 10/11 双双实证),且 npm≥11 已忽略它传的 arch/runtime/disturl env 契约(即使
  // 绿也是静默错目标)。beforePack 走 config 层 → beta-mac/cd-release 天然共用同一实现且保持
  // `--mac --x64 --arm64` 单次调用(更新 feed yml 两架构条目完整)。「没有绕过编译」由
  // scripts/verify-packaged-natives.mjs 在两个架构的打包产物上,用产物自身 Electron
  // (ELECTRON_RUN_AS_NODE,x64 经显式 Rosetta 检查)真实 require+实例化断言(electron pin+arch)。
  // build:app 链里的 rebuild:native 只服务不经打包的本地运行,进包 ABI 一律以 beforePack 为准;
  // 所以打包链路(build:app:pack,#6426)不跑那一次。
  npmRebuild: false,
  beforePack: async (context) => {
    // @@@arch-serial-contract - beforePack 里改写共享 node_modules 只在 arch 调度是硬串行时才安全。
    // 26.15.3 复核(#4394):app-builder-lib/out/packager.js doBuild L382-397 已不再是无条件串行 ——
    //   const promise = packager.pack(outDir, arch, targetList, sessionManager)
    //   if (poolCount < 2) { await promise } else { packPromises.push(promise) }   // ← 新增并行分支
    //   await tinyAsyncPool(poolCount, packPromises, ...)
    // 其中 poolCount = Math.floor(config.concurrency?.jobs || 1)。**只要没设 concurrency.jobs,
    // poolCount 恒为 1 → 走 `await promise` 分支 → 与 24.13.3 的语义完全一致**:
    // platformPackager.js L97 await doPack → L155 await emitBeforePack,整条 beforePack→copy→afterPack
    // resolve 完才进下一 arch;异步化的仍只有 target.build/finishBuild(对已物化 appOutDir,不读 node_modules)。
    //
    // 所以这里钉两样,缺一不可:
    //   1. builder 版本——新版可能再改调度语义,版本不符直接 fail loud,不赌;
    //   2. concurrency.jobs——26 起这是把 arch 推上并行的开关,一旦 ≥2,两个 arch 会同时改写同一份
    //      共享 node_modules,x64/arm64 的 .node 互相覆盖。打包能绿,装出来的包是错架构的原生模块。
    //      这种错法 verify-packaged-natives 未必每次都照得到(取决于谁最后写赢),所以在源头堵死。
    const { readFileSync } = require('node:fs')
    const path = require('node:path')
    const VERIFIED_BUILDER = '26.15.3'
    const builderVersion = JSON.parse(
      readFileSync(path.join(path.dirname(require.resolve('electron-builder')), '..', 'package.json'), 'utf8'),
    ).version
    if (builderVersion !== VERIFIED_BUILDER) {
      throw new Error(
        `[native-abi-owner] electron-builder ${builderVersion} ≠ 复核过 per-arch 串行调度契约的 ${VERIFIED_BUILDER}——` +
          '升级前先复核 doBuild 的 arch 顺序 await 仍成立(见本 hook 注释),再更新 VERIFIED_BUILDER。',
      )
    }
    // 与上面第 2 条配套:beforePack 改写共享 node_modules 的前提是 arch 串行,而串行只在 jobs<2 时成立。
    const configuredJobs = Math.floor(context.packager.config.concurrency?.jobs || 1)
    if (configuredJobs >= 2) {
      throw new Error(
        `[native-abi-owner] concurrency.jobs=${configuredJobs} 会让 electron-builder 并行打多个 arch,` +
          '而本 hook 逐架构改写的是同一份共享 node_modules——两个 arch 会互相覆盖对方的 .node。' +
          '要开并行必须先让 native rebuild 不再共享 node_modules,再解除此断言。',
      )
    }
    const { Arch } = require('electron-builder')
    const arch = Arch[context.arch]
    const { execSync, execFileSync } = require('node:child_process')
    execFileSync(process.execPath, [path.join(__dirname, 'scripts/build/build-mise-bundle.mjs'), '--platform', context.electronPlatformName, '--arch', arch], { stdio: 'inherit' })
    execFileSync(process.execPath, [path.join(__dirname, 'scripts/build/build-frpc-bundle.mjs'), '--platform', context.electronPlatformName, '--arch', arch], { stdio: 'inherit' })
    // #7199 这台电脑能做的事:Mac 包要带原生助手(日历 / 提醒 / 通讯录 / 定位 / 文字识别 / 系统授权,从源码编)与
    // cua-driver(电脑控制,下载钉住的发布包),按架构放进 mac-native/<arch>,再由下面 mac.extraResources 拷进 Resources/mac-native;
    // Windows 包同样带 cua-driver.exe,放进 win-native/<arch>,由 win.extraResources 拷进 resources/win-native。
    // 缺了它们,用户点「连接」才发现。
    if (context.electronPlatformName === 'darwin') {
      execFileSync(process.execPath, [path.join(__dirname, 'scripts/build/build-mac-native.mjs'), '--arch', arch], { stdio: 'inherit' })
    }
    if (context.electronPlatformName === 'win32') {
      execFileSync(process.execPath, [path.join(__dirname, 'scripts/build/build-win-native.mjs'), '--arch', arch], { stdio: 'inherit' })
    }
    const { createNativeAddonBuildEnv } = require('./scripts/build/native-addon-build-policy.cjs')
    // --build-from-source:@electron/rebuild 默认先走 prebuild 下载/缓存路径——run 29914453877 实证
    // 该路径在墙内 runner 上 4-5s「Rebuild Complete」却把 arm64 二进制留在 x64 slice 里(本地真编译
    // 1min+ 则正确)。交叉编译从源码走 node-gyp,确定性换取 ~1-2min/arch。
    // @@@native-addon-symbol-isolation - Mach-O loads native addons into one process namespace. node-pty
    // and @parcel/watcher both export node-addon-api template symbols by default; whichever loads first can
    // interpose the other's callback wrapper. A node-pty error then unwinds through watcher's wrapper and
    // std::terminate kills the Electron main process. Hide implementation symbols at compile time while the
    // N-API module registration entry remains exported. MSVC does not consume this POSIX compiler flag.
    const nativeBuildEnv = createNativeAddonBuildEnv(context.electronPlatformName, process.env)
    console.log(`[native-abi-owner] electron-rebuild --arch ${arch} --build-from-source (per-arch native rebuild before pack)`)
    execSync(`pnpm exec electron-rebuild --arch ${arch} --build-from-source -f --only better-sqlite3,node-pty`, {
      stdio: 'inherit',
      cwd: __dirname,
      env: nativeBuildEnv,
    })
    // @@@conpty-payload — 与 scripts/build/rebuild-native.cjs 同一条:electron-rebuild 重建了整个
    // `build/Release`,node-pty 随包的 `conpty/`(自带 ConPTY,Windows 的 pty 靠它转发终端查询)
    // 不在产物里 ⇒ 不补回来,进包的 Windows 版每条会话都死在 `Failed to load conpty.dll`。
    if (context.electronPlatformName === 'win32') {
      const { restoreWindowsConptyPayload } = require('./scripts/build/rebuild-native.cjs')
      restoreWindowsConptyPayload({ platform: 'win32', arch, root: __dirname })
    }

    // 打包前锁 arch:rebuild 产物若不是目标架构(缓存污染/静默降级/未来 rebuild 行为漂移),在这里
    // 当场红,绝不让错架构 .node 进包再靠下游 probe 兜。(lipo 仅 darwin;linux 构建为同架构原生编译)
    if (context.electronPlatformName === 'darwin') {
      const path = require('node:path')
      const want = arch === 'x64' ? 'x86_64' : 'arm64'
      for (const rel of [
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
        'node_modules/node-pty/build/Release/pty.node',
      ]) {
        const archs = execFileSync('lipo', ['-archs', path.join(__dirname, rel)], { encoding: 'utf8' }).trim()
        if (!archs.split(/\s+/).includes(want)) {
          throw new Error(`[native-abi-owner] ${rel} 实际 arch '${archs}' ≠ 目标 ${want}(${arch})——rebuild 未产出目标架构,拒绝打包`)
        }
        console.log(`[native-abi-owner] ${rel} → ${archs} ✓`)
      }
    }
  },
  // @@@app-icon-legacy-icns — 见 mac.icon 那条注释的第 2 点:mac.icon 指向 .icon 之后,
  // electron-builder 把 Resources/icon.icns 换成 actool 现派生的那份,实测只有 16/16@2x/128/128@2x
  // 四个档(79 KB)。macOS 26 读 Assets.car 不受影响,但 macOS 25 及更早、DMG 卷图标、Finder 的
  // 「显示简介」大图都只认 icns —— 让它们从 256px 拉到 512 就是肉眼可见的糊。
  // 所以在这里盖回我们自己那份 10 档完整版(scripts/build/gen-app-icons.py 产物)。
  // ❌ 别改成「不用 .icon」来回避:那样就没有三态了,那是这次换图标的主要目的。
  afterPack: async (context) => {
    // @@@npm-bundled-deps (#6552):包里的 npm 带上它自己的依赖 —— 理由见 scripts/build/pack-npm-bundled-deps.cjs。
    // 三个平台都要,所以在图标那段(只对 darwin)之前。
    const npmDeps = packNpmBundledDependencies({ appDir: packedAppDir(context), repoRoot: __dirname })
    console.log(`[npm-bundled-deps] npm 的 ${npmDeps} 个 bundled 依赖已进包`)
    // @@@packed-app-allowlist - resources/app holds the build output and its runtime dependencies, nothing else.
    // The checkout around it is not product: in CD it also carries the private operations overlay.
    const appDir = packedAppDir(context)
    const stray = [
      ...fs.readdirSync(appDir).filter((name) => !PACKED_APP_ENTRIES.has(name)),
      ...fs.readdirSync(path.join(appDir, 'apps')).filter((name) => name !== 'desktop').map((name) => `apps/${name}`),
      ...fs.readdirSync(path.join(appDir, 'apps', 'desktop')).filter((name) => name !== 'dist-electron').map((name) => `apps/desktop/${name}`),
    ]
    if (stray.length > 0) throw new Error(`[packed-app] resources/app has entries outside the build output: ${stray.join(', ')}`)
    if (context.electronPlatformName !== 'darwin') return
    const fullIcns = path.join(__dirname, 'build-resources', 'icon.icns')
    const packed = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'icon.icns',
    )
    if (!fs.existsSync(fullIcns)) {
      throw new Error(`[app-icon] build-resources/icon.icns 不存在 —— 跑 scripts/build/gen-app-icons.py 重生`)
    }
    if (!fs.existsSync(packed)) {
      throw new Error(`[app-icon] 包里没有 Contents/Resources/icon.icns(${packed}) —— electron-builder 的图标流程变了,先复核再改这里`)
    }
    fs.copyFileSync(fullIcns, packed)
    console.log(`[app-icon] Resources/icon.icns ← build-resources/icon.icns(10 档完整版,盖掉 actool 派生的 16/128 两档)`)
  },
  // @@@renderer-deps-are-dev (#4917) - electron-builder 把根 package.json **全部 production dependencies**
  // 连传递依赖按 npm 发布原样整包复制进 app/node_modules,与代码里怎么 import 无关。而渲染层依赖
  // (react / mermaid / framer-motion …)早被 vite 编译进 dist/,运行时只读那一份 ——
  // 留在 dependencies 里就是同一批代码装箱两次(0.2.40 实测:458 个包 / 150 MiB 没有任何主进程字符串
  // 引用它们)。所以**渲染层依赖一律放 devDependencies**(tests/unit/packaging/rendererDepsAreDev4917
  // 守着 dependencies 的准入名单)。dependencies 的目标是只留主进程在运行时真要从磁盘加载的东西:
  //  · 原生模块及其解析链(EMDASH_EXTERNAL + bindings/detect-libc/file-uri-to-path/is-glob…,#2282);
  //  · 按字符串 require.resolve 的 ACP 适配器(@agentclientprotocol/claude-agent-acp、codex-acp),以及
  //    claude-agent-acp 自己 import 的 @anthropic-ai/claude-agent-sdk —— 后者不是谁 resolve 它,而是
  //    pnpm 严格布局下 transitive 包不在顶层、electron-builder 收集不到,只能由根声明(acpAdapterDeps.test);
  //  · engine-downloader 用 Electron 内嵌 node 跑的 npm CLI;
  //  · rollup 没能内联、产物里仍有运行时 require 的(@supabase/* drizzle-orm @modelcontextprotocol/sdk)。
  // 「运行时真要从磁盘加载」的判据不是猜的:把真包 dist-electron 全部 js 里残留的 require/import 裸包名
  // 扫一遍(0.2.40-beta.643.1),出现的留、没出现的挪 —— 被 rollup 内联的 SDK(@team-plain/graphql、
  // @octokit/*、pino、ssh2 …)一个都没出现,已全部挪走。ssh2 挪走连带它 optional 的
  // cpu-features 出包:那份本就没编译出 .node(ignoredBuiltDependencies),ssh2 早就在 try/catch 里降级。
  // ❌ 别回到「逐包写排除规则」:@@@2143 曾在这里排 mermaid/emoji-mart 本体,但排除一个包不会排除它的
  // 依赖树 —— cytoscape/katex/d3 等 103 个包 / 30.6 MiB 照样进包、且父节点已删谁也 require 不到,
  // 漏了近一年。挪到 devDependencies 之后默认行为反过来:新加的界面库天然不进包。
  // 排除规则只剩一种正当用法(下面两条):**transitive 的平台二进制叶子包**(自身无 dependencies、根分栏
  // 够不着它、又不该随包分发)—— 那是「排叶子」,不是「排一棵树」。sourcemap 排除仍保留:主进程从不加载 .map。
  files: [
    'dist/**/*',
    'apps/desktop/dist-electron/**/*',
    'build-resources/tray-icon*.png',
    'build-resources/tray-icon*.ico',
    '!node_modules/**/*.map',
    // @@@thin-codex-native — 排掉 codex 的**平台二进制包**(@openai/codex-<os>-<arch>),
    // 实测占 543MB:arm64 产物里 codex-darwin-arm64 261MB + codex-darwin-x64 282MB 各一份
    // (pnpm 装 optional 依赖时按 os 过滤了、没按 cpu 过滤,于是两个架构都躺进来)。
    // 它们曾是 `@agentclientprotocol/codex-acp` 的传递依赖被顺带复制的(那份上游桥已于 #6394 移除,
    // codex 的 ACP 腿只走咕咕自建的桥;这条规则留作保险),**运行时一次都不会被执行**:
    //   · codex 在本仓是 hostDependency(见 session-plugins/agents/impl/codex:npmDependency
    //     ({ package: '@openai/codex' }) + homebrew 选项)——由用户自己装在机器上,app 探测 PATH;
    //   · 插件总是把那条外部路径经 CODEX_PATH / GUGU_CODEX_BIN 传给适配器,而适配器的
    //     startCodexConnection(codexPath) 只在 **codexPath 为空** 时才回退到包内 bundled 二进制。
    // 保留 `@openai/codex` 主包本身(12KB,只有 bin/package.json):适配器 dist/index.js 里那句
    // require.resolve('@openai/codex/bin/codex.js') 指的是它,排掉会让回退路径直接 resolve 失败。
    // ⚠️ 若将来把 codex 改成「随包分发」而不是 hostDependency,这条必须一并撤掉。
    '!node_modules/@openai/codex-*/**',
    // @@@thin-claude-native - Keep the SDK's JavaScript and ACP bridge, but never ship a Claude
    // CLI for any architecture. Different SDK versions can put platform packages under the
    // adapter's own node_modules, so the exclusion must match every dependency depth.
    // The plugin passes the host-installed CLI through CLAUDE_CODE_EXECUTABLE.
    excludeClaudeNative,
    // #41 files nothing loads at runtime: native build intermediates, vendored sources already compiled into
    // the shipped .node, and TypeScript sources/types (Node refuses to strip types under node_modules).
    // ❌ Broad *.md / test/ / *.c rules: playwright requires lib/mcp/test/*.js and reads lib/**/*.md, and
    // npm's bundled node-gyp needs src/*.cc.
    '!node_modules/**/build/Release/obj/**',
    '!node_modules/**/build/Release/*.lib',
    '!node_modules/**/*.{iobj,ipdb,exp,ilk,obj,tlog}',
    '!**/node_modules/better-sqlite3/build/Release/test_extension.node',
    '!node_modules/**/deps/**/*.{c,h,cc,cpp,hpp}',
    '!node_modules/**/*.{ts,mts,cts}',
    // @@@target-prebuilds - only the target's native prebuilds ship (the rebuilt Release/conpty payload stays).
    // ❌ Never as a mac/win/linux `files` list: a platform list of only `!` patterns makes electron-builder
    // add `**/*` and pack the whole checkout (0.3.1 betas shipped the repo and the CD overlay that way).
    '!**/node_modules/node-pty/prebuilds/!(${platform}-${arch})/**',
    '!**/node_modules/@parcel/watcher-!(${platform}-${arch}*)/**',
  ],
  // @@@kill-asar (#2299 / 0.2.26 闪退治本) — asar 关闭:整个 app 落地为 Contents/Resources/app/ 一棵
  // 真实目录树,不再有 app.asar(虚拟 fs)+ app.asar.unpacked(真实旁挂)的「双世界」。原本 asarUnpack
  // 存在只为把「裸 node 看得到、native 能加载」的模块强制搬到真实 fs;asar 关掉后**整包本就在真实 fs**,
  // 这批模块及其运行时 JS 依赖闭包(better-sqlite3 / node-pty / @parcel/watcher / bindings / picomatch / …
  // 全是 root prod deps)由 electron-builder 直接铺进 app/node_modules → asarUnpack 冗余,删掉不丢任何文件。
  // 消除的 bug 类:① loadEmdashBridge / gugu-im spawn 的 app.asar→app.asar.unpacked 路径改写(路径里已无
  // app.asar 可改)② node-pty helperPath 二次改写出 app.asar.unpacked.unpacked(0.2.26 闪退诱因)③ #2299 型
  // 「unpacked 模块的 JS 依赖漏在 asar 侧、require 链炸穿」。符号隔离(-fvisibility=hidden,见 beforePack)
  // 是独立机制、与 asar 无关,保留。代价:装机后文件散落磁盘(非单一 archive),Windows 深路径需实测。
  asar: false,
  // #41 Chromium's own UI strings (.pak) only for the product's two UI languages; the product picks its
  // language from app.getPreferredSystemLanguages(), not from these files.
  electronLanguages: ['zh-CN', 'en-US'],
  // @@@electron-fuses (#7195) — 翻哪几项、没翻哪几项及原因,全在 scripts/build/electron-fuses.cjs。
  electronFuses: resolveElectronFuses({ tier }),
  extraResources,
  mac: {
    // Electron's macOS locales use .lproj identifiers; zh-CN does not match zh_CN.
    electronLanguages: ['zh_CN', 'en'],
    // @@@7394 Mac 自己的标识与清单(见 TIERS 上方注释);验收包没有,沿用顶层 appId 与 channel。
    ...(t.macAppId ? { appId: t.macAppId } : {}),
    ...(t.macChannel ? { publish: { provider: 'generic', url: t.feedUrl, channel: t.macChannel } } : {}),
    // @@@app-icon-three-state — 指向 Icon Composer 三态包(浅色/深色/跟壁纸取色的着色),
    // 由 scripts/build/gen-app-icons.py 从单一源图生成。macOS 26 按用户设置渲其中一种,圆角、玻璃高光、
    // 投影都由系统加,我们只提供一张透明主体图和两个底色。
    // ⚠ 两个代价,都已在别处兜住,别顺手改回 .icns 了事:
    //   1. 出 mac 包的机器必须有 Xcode 26+ —— electron-builder 先跑 `actool --version` 卡版本
    //      (util/macosIconComposer.js),低于 26 直接抛错。mac1 是 27.0。
    //   2. 指向 .icon 之后 electron-builder **不再**用我们的 build-resources/icon.icns,而是让 actool
    //      现派生一份,实测那份只有 16/128 两档(79 KB)。macOS 25 及更早、以及 Finder 的大图标
    //      会拿 256px 往上拉 —— 所以下面 afterPack 会把包里那份盖回成 10 档的完整版。
    icon: 'build-resources/AppIcon.icon',
    category: 'public.app-category.social-networking',
    // @@@5576 zip 是给 Squirrel.Mac 用的(它只吃 zip),有了它 mac 才谈得上原生静默更新;dmg 仍要出,
    // 它是人下载安装的形态,也是 ad-hoc 存量老包的更新载体。只有带 feed 的正式通道出 zip(见 macZip)。
    //
    // 这里曾经写着「补 zip 必须等存量用户都换成签名版之后」,因为 Squirrel 要求新包满足**旧包的**
    // designated requirement,ad-hoc 旧包(DR 绑死 cdhash)升 Developer ID 新包必然不满足。#5576 不再
    // 靠「等」来满足它:判据从「feed 里有没有 zip」换成了「本地这个包自己是不是 Developer ID 签名」
    // (macDmgUpdater.ts shouldUseDmgPath),老包留在 dmg 路径,新包走 Squirrel,两边同时成立。
    // 前提是 #4831 已接上 Developer ID 签名与公证 —— 没有证书时(macIdentitySource 为空)出的是
    // ad-hoc 包,它自己也会被判成 'other' 而走 dmg 路径,不会自食其果。
    target: t.macZip ? [{ target: 'dmg' }, { target: 'zip' }] : [{ target: 'dmg' }],
    // #7199 原生组件(beforePack 编好的那一份),与顶层 extraResources 合并(app-builder-lib fileMatcher.getFileMatchers)。
    extraResources: [{ from: 'mac-native/${arch}', to: 'mac-native', filter: ['**/*'] }],
    // #7199 这台电脑能做的事:系统授权弹窗里说的「为什么要」。缺了这些键,日历 / 通讯录 / 定位的授权请求直接被拒(或进程被系统杀掉),
    // 「允许咕咕控制邮件」这类自动化授权在 hardened runtime 下也不会弹。
    extendInfo: {
      NSCalendarsUsageDescription: '你的助理要查看、新建你在「日历」里的日程(只在你于 咕咕 → 设置 → 设备 里连上「日历」之后)。',
      NSCalendarsFullAccessUsageDescription: '你的助理要查看、新建你在「日历」里的日程(只在你于 咕咕 → 设置 → 设备 里连上「日历」之后)。',
      NSRemindersUsageDescription: '你的助理要查看、新建你在「提醒事项」里的提醒(只在你于 咕咕 → 设置 → 设备 里连上「提醒事项」之后)。',
      NSRemindersFullAccessUsageDescription: '你的助理要查看、新建你在「提醒事项」里的提醒(只在你于 咕咕 → 设置 → 设备 里连上「提醒事项」之后)。',
      NSContactsUsageDescription: '你的助理要查找、管理你的联系人(只在你于 咕咕 → 设置 → 设备 里连上「通讯录」之后)。',
      NSLocationUsageDescription: '你的助理要用这台电脑的位置回答「附近」「我在哪」这类问题(只在你于 咕咕 → 设置 → 设备 里连上「位置」之后)。',
      NSLocationWhenInUseUsageDescription: '你的助理要用这台电脑的位置回答「附近」「我在哪」这类问题(只在你于 咕咕 → 设置 → 设备 里连上「位置」之后)。',
      NSMicrophoneUsageDescription: '录语音笔记要用麦克风(只在你于助理的聊天框「+」里开始录音之后)。',
      NSAppleEventsUsageDescription: 'Allow your agents and installed Apps to communicate with desktop applications when you ask them to.'
    },
    ...macSigning
  },
  win: {
    // 9 档尺寸 16→256,scripts/build/gen-app-icons.py 生成。此前这一项是空的,electron-builder 只能
    // 临时从 icns 转一份出来 —— 尺寸档位由它自己定,任务栏/开始菜单的小尺寸得不到专门优化。
    icon: 'build-resources/icon.ico',
    // @@@windows-ascii-exe - keep the visible productName localized, but make the actual .exe name
    // ASCII so process.execPath is safe to pass through PowerShell/CMD agent launchers.
    executableName: t.artifactPrefix,
    // #7199 cua-driver.exe 与它的工具清单(beforePack 放好的那一份),与顶层 extraResources 合并。
    extraResources: [{ from: 'win-native/${arch}', to: 'win-native', filter: ['**/*'] }],
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    // #2489: assisted mode exposes the directory page; one-click installers intentionally
    // ignore allowToChangeInstallationDirectory and install directly to the default path.
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    ...(t.nsisInclude ? { include: t.nsisInclude } : {})
  },
  // @@@linux-target - AppImage x64 (single-file, no install). Build ON Linux (native amd64), not
  // cross-built from macOS: the vendored tmux (@@@bundle-tmux) is platform-specific, so a macOS host
  // would bundle the macOS tmux into the Linux artifact. Linux needs a PNG icon (icns is rejected).
  linux: {
    icon: 'public/assets/app/gugu-icon-512.png',
    category: 'Network',
    target: [{ target: 'AppImage', arch: ['x64'] }]
  },
  publish: {
    provider: 'generic',
    url: t.feedUrl,
    channel: t.channel
  }
}
