// @@@update-policy — 更新的**判据**:哪些包该追更新、追到的目标认不认、状态往不往回退。
// 两个宿主共用这一份:桌面主进程(electron/main.ts,electron-updater)与安卓壳
// (src/platform/capacitorAppUpdate.ts,原生插件下载 + 系统安装器)。判据只写一次 ——
// 两边各写一份,迟早一边放行另一边拒绝,而那种分叉不报错。
// 这里只有纯函数:❌ 不认识任何地址(feed 在 electron/updateFeeds.json)、❌ 不碰任何宿主 API。

export type BuildDistribution = 'local' | 'published'

export type UpdaterPolicy =
  | { enabled: true }
  | {
      enabled: false
      status: 'disabled'
      reason: 'development-build' | 'local-build' | 'no-channel'
      messageKey: string
    }

/** Missing distribution deliberately means local; published authority is always explicit. */
export function parseBuildDistribution(value: unknown): BuildDistribution {
  const distribution = value ?? 'local'
  if (distribution === 'local' || distribution === 'published') return distribution
  throw new Error(
    `Unknown GUGU_BUILD_DISTRIBUTION '${String(distribution)}' — expected local or published`
  )
}

export function resolveUpdaterPolicy(input: {
  isPackaged: boolean
  distribution: BuildDistribution
  channel: UpdateChannel
}): UpdaterPolicy {
  if (!input.isPackaged) {
    return {
      enabled: false,
      status: 'disabled',
      reason: 'development-build',
      // ⚠️ 给的是**词表 key**,不是成品串:这句会经 IPC 一路显示在「关于」页,
      // 主进程没有界面语言这个概念(用户可以随时切),成品串必然在某种语言下是错的。
      messageKey: 'about.updateDisabledDevelopment',
    }
  }
  if (input.distribution === 'local') {
    return {
      enabled: false,
      status: 'disabled',
      reason: 'local-build',
      messageKey: 'about.updateDisabledLocal',
    }
  }
  // @@@5737 没有通道的 tier(验收包)不自动更新:它是手递手给人的测试包,升到任何别的东西上
  // 都是换成了另一个应用。「关于」页照实说,❌ 不装作在检查更新。
  if (input.channel === 'none') {
    return {
      enabled: false,
      status: 'disabled',
      reason: 'no-channel',
      messageKey: 'about.updateDisabledNoChannel',
    }
  }
  return { enabled: true }
}

/** 一个包跟哪条更新通道。none = 不自动更新(手递手的验收包)。 */
export type UpdateChannel = 'stable' | 'beta' | 'none'

/**
 * @@@5837 更新状态**不往回退**:包已经下好(或已打开待拖装)之后,再来一条「发现新版本」
 * 「已是最新」「检查失败」都不该把它抹掉 —— 抹掉就等于把用户唯一的安装入口拿走,而那个包
 * 明明还躺在本地等着装。只有真的又下好了别的东西才改写它。
 *
 * 这条规则以前长在渲染层(UpdateBanner 里那串 `prev === 'ready' ? prev : ...`),于是界面
 * 一重载,规则和状态一起没了 —— 而主进程明明还知道包在等人按。规则跟着状态一起归宿主
 * (桌面是主进程,安卓是 capacitorAppUpdate 那个模块 —— 它比任何一个界面组件活得久)。
 */
export function updateStateAdvances(current: string, next: string): boolean {
  const staged = current === 'downloaded' || current === 'downloaded-manual'
  if (!staged) return true
  // 又在下更新的一版,也改写它:electron-updater 开始下新包时就把 pending 里那一份清掉了
  // (DownloadedUpdateHelper.cleanCacheDirForPendingUpdate),旧的那份已经装不了,「可以装了」是假话。
  return next === 'downloaded' || next === 'downloaded-manual' || next === 'downloading'
}

/**
 * feed 报来的这条更新该不该拒绝当作更新目标。**判据随通道走**:
 *  - 正式通道:目标必须是稳定版(spec:测试版永不作为更新目标)。这道闸是 @@@2177 的第二道,
 *    防的是正式 feed 被误发了预发布包,原样保留。
 *  - Beta 通道:整条通道就是预发布版,当然收 —— 只挡形状不对的(缺 version、不是 x.y.z)。
 *  - 没有通道:一律拒绝。压根不该查到这里,查到了也不认。
 */
export function shouldRejectUpdateTarget(updateInfo: unknown, channel: UpdateChannel): boolean {
  const version = (updateInfo as { version?: unknown } | null | undefined)?.version
  if (channel === 'none') return true
  if (channel === 'beta') return !isParsableVersion(version)
  return !isStableVersion(version)
}

/** 版本号形状认不认得出(不管有没有预发布段)。认不出一律 false,与 isStableVersion 同一条 fail closed。 */
export function isParsableVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const trimmed = version.trim().replace(/^v/i, '')
  return /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.test(trimmed)
}

/**
 * 版本号是不是稳定版(无 semver 预发布段)。
 * `0.2.28` → true;`0.2.28-beta.188.1` / `1.0.0-rc.1` → false。
 * 认不出的输入一律判 false(fail closed):宁可不提示更新,也不把用户往来路不明的版本上引。
 */
export function isStableVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const trimmed = version.trim().replace(/^v/i, '')
  // semver core(x.y.z)+可选预发布段/构建元数据;只认严格三段数字,别的形状不猜
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed)
  if (!match) return false
  return match[4] === undefined
}
