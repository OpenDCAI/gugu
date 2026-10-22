#!/usr/bin/env node
// @@@mac-signing 出厂门 —— 断言 release/ 里的 mac 产物真的是「用户双击就能开」的那一档。
//
// 为什么需要这道门:签名与公证的失败模式几乎全是**静默**的 ——
//   · CSC_IDENTITY_AUTO_DISCOVERY=false 让 electron-builder 跳过签名,只 warn 一行;
//   · 公证凭据缺失时 notarizeIfProvided() 打一句 "skipped macOS notarization" 就过;
//   · hardened runtime 没开、entitlements 没进去,codesign 照样成功。
// 三种都能让整条 CD 绿着把一个会被 Gatekeeper 拦的 dmg 发出去。这里逐条查产物本身。
//
// 用法:node scripts/verify-mac-signature.mjs <releaseDir> <TEAM_ID> [--expect-zip]
// 只在配了签名凭据的构建上跑;ad-hoc 档不该调用它(调了必红,那是正确的)。
// --expect-zip:该通道出 zip(自动更新载体)→ 缺了就红,有就展开验签。有 feed 的通道都传它
// (@@@5576 正式、@@@5737 Beta);acceptance 不自动更新、按设计不出 zip,不传即不卡。
// --expect-provisioned <Mac 标识>(@@@7394):该包应以这个标识发布并嵌着本团队的描述文件 —— 标识对、描述文件
// 在且绑的就是 <TEAM_ID>.<标识>、主程序带着描述文件授权的受限权限、辅助进程**不带**(带了会被系统当场杀掉)。
// 这几条全是静默失败:描述文件没嵌进去,包照样签得出、照样能跑,只是 Touch ID 通行密钥悄悄没了。

import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const expectZip = argv.includes('--expect-zip')
const provisionedAt = argv.indexOf('--expect-provisioned')
const expectBundleId = provisionedAt >= 0 ? argv[provisionedAt + 1] : null
const [releaseDir, teamId] = argv.filter((a, i) => !a.startsWith('--') && (provisionedAt < 0 || i !== provisionedAt + 1))
const USAGE = '用法: node scripts/verify-mac-signature.mjs <releaseDir> <TEAM_ID> [--expect-zip] [--expect-provisioned <Mac 标识>]'
if (!releaseDir || !teamId) {
  console.error(USAGE)
  process.exit(2)
}
if (provisionedAt >= 0 && (!expectBundleId || expectBundleId.startsWith('--'))) {
  console.error(`--expect-provisioned 后面要跟 Mac 标识\n${USAGE}`)
  process.exit(2)
}
if (process.platform !== 'darwin') {
  console.error('只能在 macOS 上跑(codesign/spctl/stapler 都是系统工具)')
  process.exit(2)
}
if (!/^[A-Z0-9]{10}$/.test(teamId)) {
  console.error(`TEAM_ID "${teamId}" 不像 10 位 Apple Team ID —— 传错了值,不猜`)
  process.exit(2)
}

/**
 * 跑命令,不管退出码都把 stdout+stderr 原样带回。
 *
 * ❗ codesign -dv 和 spctl -vvv 把**全部干货写 stderr**、并且退出码 0 —— 走成功分支时
 * 只取 stdout 就会拿到空字符串,于是所有"读输出内容"的断言一律判假,而失败详情也是空的
 * (2026-09-02 run 33670638852 实测:产物完全正常,门却红了 3 条、详情全空)。
 * 所以两个分支都必须合并 stderr,execFileSync 的 stdio 也不能让 stderr 直通父进程。
 */
function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error) return { ok: false, out: String(r.error.message) }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    return { ok: r.status === 0, out }
  } catch (e) {
    return { ok: false, out: String(e?.message ?? e) }
  }
}

const failures = []
function check(label, passed, detail) {
  if (passed) {
    console.log(`  ✅ ${label}`)
  } else {
    console.log(`  ❌ ${label}`)
    failures.push(`${label}\n${detail.trim().split('\n').map((l) => `      ${l}`).join('\n')}`)
  }
}

// release/mac/ 与 release/mac-arm64/ 各一个 .app(productName 是中文,别按名字猜,扫目录)。
function findApps(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = join(dir, entry.name)
    if (entry.name.endsWith('.app')) {
      found.push(sub)
      continue
    }
    for (const inner of readdirSync(sub, { withFileTypes: true })) {
      if (inner.isDirectory() && inner.name.endsWith('.app')) found.push(join(sub, inner.name))
    }
  }
  return found
}

const apps = findApps(releaseDir)
const dmgs = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((f) => f.endsWith('.dmg')).map((f) => join(releaseDir, f))
  : []
// @@@5576 zip = Squirrel.Mac 自动更新的载体,与 dmg 一样是出厂物,下面要展开逐个验签。
const zips = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((f) => f.endsWith('.zip')).map((f) => join(releaseDir, f))
  : []

// 找不到产物本身就是失败:空目录跑出一个「全过」是这类门最经典的假绿。
if (apps.length === 0) {
  console.error(`❌ ${releaseDir} 下没找到任何 .app —— 没有产物可验,拒绝报绿`)
  process.exit(1)
}
if (dmgs.length === 0) {
  console.error(`❌ ${releaseDir} 下没找到任何 .dmg —— 没有产物可验,拒绝报绿`)
  process.exit(1)
}

/** plist XML 里某个 key 后面紧跟的 <string>;取不到为 null。 */
function plistString(xml, key) {
  const m = new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m ? m[1] : null
}
/** plist XML 里某个 key 后面紧跟的 <array> 中的全部 <string>。 */
function plistStrings(xml, key) {
  const m = new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)
  return m ? [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]) : []
}

/**
 * @@@7394 描述文件与受限权限(见文件头 --expect-provisioned)。标识、描述文件、主程序权限、辅助进程权限逐条判。
 * `label` 只用于输出;`deep` 为 false 时(zip 里解出的那一份)只判标识与描述文件 —— 权限已在 .app 上判过,
 * zip 要防的是「解出来的不是同一个包」。
 */
function checkProvisioned(app, label, deep) {
  const appIdentifier = `${teamId}.${expectBundleId}`
  const bundleId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')])
  check(`${label}标识 = ${expectBundleId}`, bundleId.ok && bundleId.out.trim() === expectBundleId, bundleId.out)

  const profilePath = join(app, 'Contents/embedded.provisionprofile')
  const profile = existsSync(profilePath) ? run('/usr/bin/security', ['cms', '-D', '-i', profilePath]) : { ok: false, out: '(没有 Contents/embedded.provisionprofile)' }
  check(
    `${label}嵌着绑 ${appIdentifier} 的描述文件`,
    profile.ok && plistString(profile.out, 'com.apple.application-identifier') === appIdentifier,
    profile.out
  )
  if (!deep) return

  const main = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app])
  check(
    '主程序带描述文件授权的受限权限(application-identifier / team-identifier / keychain-access-groups 含 .webauthn)',
    main.ok &&
      plistString(main.out, 'com.apple.application-identifier') === appIdentifier &&
      plistString(main.out, 'com.apple.developer.team-identifier') === teamId &&
      plistStrings(main.out, 'keychain-access-groups').includes(appIdentifier) &&
      // Touch ID 通行密钥存在这一组(运行期 macWebAuthn.ts 按同一规则推出它),缺了 configureWebAuthn 第一次用就被系统拒。
      plistStrings(main.out, 'keychain-access-groups').includes(`${appIdentifier}.webauthn`),
    main.out
  )

  const frameworks = join(app, 'Contents/Frameworks')
  const helpers = existsSync(frameworks) ? readdirSync(frameworks).filter((f) => f.endsWith('.app')).map((f) => join(frameworks, f)) : []
  check('找得到辅助进程(Helper .app)', helpers.length > 0, `found: ${helpers.join(', ') || '(none)'}`)
  for (const helper of helpers) {
    const ent = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', helper])
    check(
      `${helper.split('/').pop()} 不带受限权限(它没有自己的描述文件,带了会被系统杀掉)`,
      ent.ok && !/com\.apple\.application-identifier|keychain-access-groups/.test(ent.out),
      ent.out
    )
  }
}

for (const app of apps) {
  console.log(`\n🔍 ${app}`)

  // 1) 签名结构完整(--deep 连 Helper/Framework/tmux-bundle 里的 dylib 一起走一遍)
  const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  check('codesign --verify --deep --strict', verify.ok, verify.out)

  // 2) 签名主体真是自家 Developer ID,且 hardened runtime 开着
  const info = run('/usr/bin/codesign', ['-dv', '--verbose=4', app])
  const text = info.out
  // --xml 必须显式要:新版 codesign(macOS 26 起)默认把 entitlements 印成 [Dict]/[Key]/[Value] 文本,
  // 下面按 plist XML 匹配的正则就会对一个授权齐全的产物判假(beta run 38982224524 实撞)。
  const automation = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app])
  check(
    '可请求桌面自动化授权(Apple Events entitlement)',
    automation.ok && /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\s*\/>/.test(automation.out),
    automation.out
  )
  const usage = run('/usr/bin/plutil', ['-extract', 'NSAppleEventsUsageDescription', 'raw', '-o', '-', join(app, 'Contents/Info.plist')])
  check('桌面自动化授权用途说明', usage.ok && usage.out.trim().length > 0, usage.out)
  check(
    `签名主体 = Developer ID Application (${teamId})`,
    /Authority=Developer ID Application:/.test(text) && text.includes(`TeamIdentifier=${teamId}`),
    text
  )
  check('hardened runtime 已启用 (flags 含 runtime)', /flags=.*runtime/.test(text), text)

  // 3) 公证票据已 staple 到 app 上 —— 用户离线首次打开也不会被拦
  const staple = run('/usr/bin/xcrun', ['stapler', 'validate', app])
  check('公证票据已装订 (stapler validate)', staple.ok, staple.out)

  // 4) Gatekeeper 的最终裁决。source 必须是 Notarized Developer ID:
  //    只签不公证时这里会是 "Developer ID" 而 accepted 仍可能出现,所以两条都要判。
  const assess = run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'exec', app])
  check(
    'Gatekeeper: accepted, source=Notarized Developer ID',
    assess.ok && /source=Notarized Developer ID/.test(assess.out),
    assess.out
  )

  if (expectBundleId) checkProvisioned(app, '', true)
}

// ❌ 这里**不**对 dmg 跑 spctl。曾经加过一条「Gatekeeper 接受该 dmg」,它必然红,
// 而那是错的判据不是坏产物:electron-builder 26 的 schema 对 dmg.sign 写得很明白 ——
//   "Whether to sign the DMG or not. Signing is not required and will lead to
//    unwanted errors in combination with notarization requirements."
// dmg 只是承载 .app 的壳,签名与公证都落在 .app 上并 staple 进去;用户拖出来运行的是 .app,
// 它带着自己的公证票据。拿 `spctl -t open` 去卡一个按设计就不该签的容器,是给自己造假红。
// (2026-09-02 实测:dmg `code object is not signed at all` 而 .app `accepted /
//  source=Notarized Developer ID` —— 两者并存正是预期状态。)
// dmg 仍然要在上面做存在性检查:出厂物必须真的产出了 dmg,空目录报绿是这类门最经典的假绿。
console.log(`\n🔍 dmg 产物(${dmgs.length} 个):${dmgs.map((d) => d.split('/').pop()).join(', ')}`)
console.log('  ℹ️  dmg 按设计不签名(见上方注释),签名与公证的判据全部落在 .app 上')

// @@@5576 zip 要展开验 —— 它和 dmg 不是一回事。dmg 是给人拖的壳,zip 是 **Squirrel.Mac 自动更新
// 唯一能下的形态**,用户机器上替换掉旧 app 的就是从它里面解出来的那一份。而 .app 里有符号链接
// (Frameworks/Versions/Current 之类),打包方式不对(比如用 `zip` 而不是 `ditto`)会把链接压成副本,
// 解出来签名当场失效 —— 那时 Squirrel 装完起不来,而用户那边只看到「更新了但没变」。
// 所以这里真解一次、真验一次,不拿「.app 验过了 zip 就一定没问题」蒙混。
if (expectZip && zips.length === 0) {
  console.error(`❌ ${releaseDir} 下没找到任何 .zip —— 该通道应出自动更新载体(@@@5576),拒绝报绿`)
  process.exit(1)
}
// 反向也卡:不该出 zip 的通道冒出 zip = tier 配置漂了,同样不许静默放行。
if (!expectZip && zips.length > 0) {
  console.error(`❌ 未传 --expect-zip 却出了 ${zips.length} 个 zip(${zips.map((z) => z.split('/').pop()).join(', ')})——tier 配置与调用方不一致,拒绝报绿`)
  process.exit(1)
}
for (const zip of zips) {
  const label = zip.split('/').pop()
  console.log(`\n🔍 ${label}(展开验签)`)
  const tmp = mkdtempSync(join(tmpdir(), 'gugu-zip-verify-'))
  try {
    // ditto -x -k:与 electron-builder 打包时同一套工具,保留符号链接与权限位。
    const extract = run('/usr/bin/ditto', ['-x', '-k', zip, tmp])
    check(`${label} 可解包 (ditto -x -k)`, extract.ok, extract.out)
    if (!extract.ok) continue

    const inner = readdirSync(tmp).filter((f) => f.endsWith('.app')).map((f) => join(tmp, f))
    check(`${label} 里有且仅有一个 .app`, inner.length === 1, `found: ${inner.join(', ') || '(none)'}`)
    if (inner.length !== 1) continue

    const app = inner[0]
    const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    check(`${label} 内 .app 签名结构完整`, verify.ok, verify.out)

    const info = run('/usr/bin/codesign', ['-dv', '--verbose=4', app])
    check(
      `${label} 内 .app 主体 = Developer ID Application (${teamId})`,
      /Authority=Developer ID Application:/.test(info.out) && info.out.includes(`TeamIdentifier=${teamId}`),
      info.out
    )

    // 公证票据必须随 zip 一起走:Squirrel 换上去的 app 要能离线通过 Gatekeeper。
    const staple = run('/usr/bin/xcrun', ['stapler', 'validate', app])
    check(`${label} 内 .app 公证票据已装订`, staple.ok, staple.out)

    // @@@7394 Squirrel 换上去的就是这一份:标识与描述文件得跟 .app 一致。
    if (expectBundleId) checkProvisioned(app, `${label} 内 .app `, false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error(`\n::error::mac 签名出厂门未通过(${failures.length} 项)——拒绝出厂`)
  for (const f of failures) console.error(`\n  · ${f}`)
  process.exit(1)
}

console.log(`\n✅ mac 签名出厂门通过:${apps.length} 个 .app + ${dmgs.length} 个 dmg` + (expectZip ? ` + ${zips.length} 个 zip(已展开验签)` : '(该通道不出 zip)') + ' 全部为已公证的 Developer ID 产物')
