// @@@5747 装完之后把下载缓存清掉。
//
// 实测(owner 2026-09-17,更新到 0.2.43-beta.657.1 之后):`~/Library/Caches/gugu-beta-updater/` 里
// 仍躺着 `update.zip` 172MB + `pending/<同一个包>.zip` 又 172MB —— 同一份东西存了两遍、共 348MB,
// 而那一版已经装好了。每更新一次多留一份,用户那边只增不减。
//
// 清理放在**启动时**而不是安装后:安装那一刻进程正在死,再去删几百兆是给退出加风险;
// 而新版本起来之后,缓存里那份「待装的包」已经是过去式,判据也最硬 —— 它不比正在跑的这一版新。
//
// @@@diff-base 清 pending 和弃用的 staged 子目录,保留整个缓存的顶层。那一份是**下一次差分下载的底**:
//   - Windows NSIS:`installer.exe`,由新版安装器在安装时把自己拷过来(app-builder-lib
//     templates/nsis/include/installer.nsh 的 `copyFile "$EXEPATH" …\installer.exe`);
//   - mac zip:`update.zip`,由 MacUpdater 在下载完成时拷过来;
//   - 两边都还有一份 `current.blockmap`(这一版的块表,省一次下载)。
// 原先整目录 rmSync,底每次都被删 —— owner 的 Windows 上 61.1/62.1/63.1 三次更新全是
// `Cannot download differentially … ENOENT installer.exe`,198MB 整包重下(10-08 实测)。
// 代价:装完之后常驻一份底(Windows ≈200MB、mac ≈172MB);下好待装那段时间是底 + pending 两份,
// 装完下一次启动回到一份。
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 更新缓存所在的那层目录。**照抄 electron-updater 自己的规则**
 * (`out/AppAdapter.js` 的 `getAppCacheDir`),因为要删的正是它建的目录 —— 两边各写各的就会
 * 出现「删了个空地方、真残留还在」,而那种失败是静默的。
 * ⚠️ 不能用 `app.getPath('cache')`:Electron 的类型里没有这个键,而且语义也不是同一个。
 */
export function updaterCacheBaseDir(platform: NodeJS.Platform = process.platform): string {
  const home = homedir()
  if (platform === 'win32') return process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  return process.env.XDG_CACHE_HOME || join(home, '.cache')
}

/** 拆成「核心三段 + 预发布段」。认不出返回 null。 */
function parse(version: string): { core: number[]; pre: string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim().replace(/^v/i, ''),
  )
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * a 比 b 新返回正数。按 semver 的规矩:先比核心三段,再比预发布段
 * (有预发布段的**小于**没有的;段内两边都是数字就按数字比,否则按字典序)。
 *
 * ⚠️ 这里不能图省事拿字符串整体比大小:`0.2.43-beta.658.1` 与 `0.2.43-beta.657.1` 核心三段相同,
 * 字符串比能得出对的结论纯属巧合,而 `beta.99` 与 `beta.100` 就会反 —— 那会把刚下好的新包当成
 * 旧残留删掉,用户白下一次 172MB。
 */
function compare(a: { core: number[]; pre: string[] }, b: { core: number[]; pre: string[] }): number {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const bothNumeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (bothNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * 缓存里那份包该不该删。
 *
 * 判据是「它不比正在跑的这一版新」——**相等也删**:相等意味着它就是刚刚装上的那一份。
 * 只有确实更新的那一份留着(下到一半、还没装的),删了等于让用户白下一次。
 *
 * 认不出版本号(`stagedVersion === null`)时删:那对应「pending 里压根没有记录」,
 * 没有记录的残留没人会用,留着只占盘。⚠️ 「有记录但读不出版本」是**另一回事**,
 * 由 purgeStaleUpdaterCache 单独挡掉 —— 见 @@@5846。
 */
export function shouldPurgeStagedUpdate(stagedVersion: string | null, runningVersion: string): boolean {
  if (stagedVersion === null) return true
  const staged = parse(stagedVersion)
  if (staged === null) return true
  const running = parse(runningVersion)
  if (running === null) return false // 读不出自己的版本时不动别人的东西
  return compare(staged, running) <= 0
}

/** pending 里有没有一份「下好了等着装」的记录。有记录却读不出版本,与压根没有记录是两回事。 */
export function hasStagedInfo(cacheDir: string): boolean {
  return existsSync(join(cacheDir, 'pending', 'update-info.json'))
}

/**
 * @@@5846 artifactName 是 `<前缀>-${version}-${arch}.${ext}`(electron-builder.cjs),
 * 版本号唯一还留着的地方就是文件名。架构段按已知集合锚定,否则 `gugu-0.2.46-arm64.zip`
 * 会被当成预发布段 `arm64` 读成「0.2.46-arm64」。
 */
export function versionFromArtifactName(fileName: unknown): string | null {
  if (typeof fileName !== 'string') return null
  const name = fileName.trim()
  const semver = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)`
  const withArch = new RegExp(`-${semver}-(?:arm64|x64|ia32|armv7l|universal|arm|amd64|x86_64)\\.[A-Za-z0-9]+$`)
  const withoutArch = new RegExp(`-${semver}\\.[A-Za-z0-9]+$`)
  return withArch.exec(name)?.[1] ?? withoutArch.exec(name)?.[1] ?? null
}

/**
 * 从 pending/update-info.json 读出缓存里那份包的版本;读不到返回 null。
 *
 * ⚠️ @@@5846 **这个文件里没有 version 字段**:electron-updater 写进去的只有
 * `{fileName, sha512, isAdminRightsRequired}`(DownloadedUpdateHelper.setDownloadedFile,
 * 6.8.3 仍是如此),从来不写版本号。原先直接读 `version`,于是恒为 null、恒走「一律删」那条
 * —— **每次启动都把待装的包整个删掉**,包括一个刚下好、比当前版本还新的完整包。
 * owner 的机器上连着五次启动都是 `stagedVersion:null` + 「已清掉过期的更新缓存」,
 * 上面那句「只有确实更新的那一份留着」是一条从来没被执行过的死分支。
 *
 * 所以版本号从文件名里取。`version` 字段仍然优先读 —— 哪天它真写了,或者被人手工补过。
 */
export function readStagedVersion(cacheDir: string): string | null {
  const infoPath = join(cacheDir, 'pending', 'update-info.json')
  if (!existsSync(infoPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(infoPath, 'utf8'))
    const record = parsed as { version?: unknown; fileName?: unknown } | null
    const declared = typeof record?.version === 'string' ? record.version.trim() : ''
    return declared !== '' ? declared : versionFromArtifactName(record?.fileName)
  } catch {
    return null
  }
}

/**
 * 清掉过期的待装包(`pending/`),留着差分下载的底。返回是否清掉 pending。
 * 弃用的预解压目录异步删除,避免清几千个文件挡住新版本首屏。
 * 任何异常都吞掉:清理失败只是白占盘,❌ 不该让它挡住应用启动。
 */
export function purgeStaleUpdaterCache(opts: {
  cacheDir: string
  runningVersion: string
  log?: (message: string, meta: Record<string, unknown>) => void
}): boolean {
  const { cacheDir, runningVersion } = opts
  void rm(join(cacheDir, 'staged'), { recursive: true, force: true }).catch((error) => {
    opts.log?.('[updater] 清更新缓存失败(只是白占盘,不影响启动)', { cacheDir, error: String(error) })
  })
  const pendingDir = join(cacheDir, 'pending')
  if (!existsSync(pendingDir)) return false
  const stagedVersion = readStagedVersion(cacheDir)
  // @@@5846 有一份 pending 记录、却读不出它是哪一版 —— 不删。删错的代价是用户白下几百兆,
  // 留错的代价只是占盘,而占盘这件事有下面这行日志能发现,白下一次没有任何痕迹。
  if (stagedVersion === null && hasStagedInfo(cacheDir)) {
    opts.log?.('[updater] pending 里那份认不出版本,先留着不删', { cacheDir, runningVersion })
    return false
  }
  if (!shouldPurgeStagedUpdate(stagedVersion, runningVersion)) {
    opts.log?.('[updater] 缓存里那份比当前版本新,留着', { stagedVersion, runningVersion })
    return false
  }
  try {
    rmSync(pendingDir, { recursive: true, force: true })
    opts.log?.('[updater] 已清掉过期的更新缓存', { pendingDir, stagedVersion, runningVersion })
    return true
  } catch (error) {
    opts.log?.('[updater] 清更新缓存失败(只是白占盘,不影响启动)', { pendingDir, error: String(error) })
    return false
  }
}
