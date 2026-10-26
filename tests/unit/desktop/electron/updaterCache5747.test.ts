// @@@5747 装完之后清缓存。实测那次更新之后本机留了 348MB(同一个包存了两遍),而版本已经装好了。
// 这里钉的是那条判据本身——它有一侧特别贵:**误删一份刚下好的新包 = 用户白下 172MB**,
// 所以「比我新就留着」必须在各种版本号形状下都成立,尤其是预发布段要按数字比而不是按字典序。
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  purgeStaleUpdaterCache,
  readStagedVersion,
  shouldPurgeStagedUpdate,
  versionFromArtifactName,
} from '../../../../apps/desktop/electron/updaterCache'

const dirs: string[] = []
const locked: string[] = []
afterEach(() => {
  for (const d of locked.splice(0)) chmodSync(d, 0o755)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function cacheDir(stagedVersion: string | null, extra: 'none' | 'zip' = 'zip'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5747-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'pending'), { recursive: true })
  if (extra === 'zip') writeFileSync(join(dir, 'update.zip'), 'x')
  if (stagedVersion !== null) {
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({ version: stagedVersion }))
  }
  return dir
}

describe('#5747 该不该清掉缓存里那份包', () => {
  it.each([
    // 刚装上的那一版 —— 缓存里那份就是它自己，清。
    ['与当前版本相同', '0.2.43-beta.657.1', '0.2.43-beta.657.1', true],
    ['正式版与当前相同', '0.2.44', '0.2.44', true],
    ['比当前旧', '0.2.42', '0.2.43', true],
    ['预发布段比当前旧', '0.2.43-beta.656.1', '0.2.43-beta.657.1', true],
    // ⚠️ 这一条最贵:下到一半、还没装的新包，删了等于让用户白下一次。
    ['比当前新', '0.2.44', '0.2.43', false],
    ['预发布段比当前新', '0.2.43-beta.658.1', '0.2.43-beta.657.1', false],
    // 按数字比而不是字典序:字典序会判 "beta.99" > "beta.100"，把新包当旧残留删掉。
    ['预发布段跨位数(100 > 99)', '0.2.43-beta.100.1', '0.2.43-beta.99.1', false],
    ['预发布段跨位数(99 < 100)', '0.2.43-beta.99.1', '0.2.43-beta.100.1', true],
    // 正式版比同号的预发布版新。
    ['正式版 vs 同号预发布', '0.2.43', '0.2.43-beta.657.1', false],
    ['预发布 vs 同号正式版', '0.2.43-beta.657.1', '0.2.43', true],
  ] as const)('%s → %s', (_label, staged, running, expected) => {
    expect(shouldPurgeStagedUpdate(staged, running)).toBe(expected)
  })

  it('读不出版本的残留一律清(连版本都读不出,没人会用它)', () => {
    expect(shouldPurgeStagedUpdate(null, '0.2.43')).toBe(true)
    expect(shouldPurgeStagedUpdate('latest', '0.2.43')).toBe(true)
    expect(shouldPurgeStagedUpdate('', '0.2.43')).toBe(true)
  })

  it('读不出**自己**的版本时什么都不动 —— 没有判据就不该动别人的东西', () => {
    expect(shouldPurgeStagedUpdate('0.2.42', 'unknown')).toBe(false)
  })
})

describe('#5747 落到磁盘上', () => {
  it('装完之后 pending 被清掉,差分下载的底(mac update.zip)留着', () => {
    const dir = cacheDir('0.2.43-beta.657.1')
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.43-beta.657.1' })).toBe(true)
    expect(existsSync(join(dir, 'pending'))).toBe(false)
    expect(existsSync(join(dir, 'update.zip'))).toBe(true)
  })

  it('缓存里那份更新时原样留着', () => {
    const dir = cacheDir('0.2.44')
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.43' })).toBe(false)
    expect(existsSync(join(dir, 'update.zip'))).toBe(true)
  })

  it('没有 update-info.json 的孤儿包也清', () => {
    const dir = cacheDir(null)
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.43' })).toBe(true)
    expect(existsSync(join(dir, 'pending'))).toBe(false)
  })

  it('目录不存在 → 什么都不做,不抛', () => {
    expect(purgeStaleUpdaterCache({ cacheDir: '/nonexistent/gugu-updater', runningVersion: '0.2.43' })).toBe(false)
  })

  it('update-info.json 是坏的 → 不抛,而且**不删**(@@@5846:读不出不等于该扔)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5747-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'update-info.json'), '{ not json')
    expect(readStagedVersion(dir)).toBeNull()
    // 原来这里判 true(删)。删错的代价是用户白下几百兆,留错的代价只是占盘 —— 而且坏掉的
    // update-info.json 下次下载时由 electron-updater 自己 cleanCacheDirForPendingUpdate 清掉。
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.43' })).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})

// @@@5846 这一条是上面那整套判据的前提:版本号得读得出来。
//
// 实测:electron-updater 写进 pending/update-info.json 的只有 {fileName, sha512,
// isAdminRightsRequired},**从来没有 version 字段**。原先直接读 `version`,于是 stagedVersion
// 恒为 null、恒走「认不出一律删」—— 每次启动都把待装的包整个删掉。owner 的机器上连着五次启动
// 都是 `"stagedVersion":null` + 「已清掉过期的更新缓存」,而 #5747 写的「只有确实更新的那一份
// 留着」从来没有执行过。他 10:01 静默下好的 185MB,只要重开一次应用就会白下一遍。
describe('#5846 版本号得从文件名里取 —— update-info.json 里根本没有', () => {
  it('owner 机器上那份真实记录(electron-updater 原样写的,没有 version)读得出版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5846-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.46-beta.4.1-arm64.zip',
      sha512: 'E/IWRjeFMilCPcMun8+WjNvXquB0JPaeyEA7hAwrCC7utJPFfjWsDq+J9cXxLx2LW2WvGlGOIfrl1omLAafpQg==',
      isAdminRightsRequired: false,
    }))
    expect(readStagedVersion(dir)).toBe('0.2.46-beta.4.1')
  })

  it('于是它不会再被当成过期残留删掉 —— 这正是白下 185MB 的那一步', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5846-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.46-beta.4.1-arm64.zip', sha512: 'x', isAdminRightsRequired: false,
    }))
    writeFileSync(join(dir, 'pending', 'gugu-beta-0.2.46-beta.4.1-arm64.zip'), 'x')
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.45-beta.677.1' })).toBe(false)
    expect(existsSync(join(dir, 'pending', 'gugu-beta-0.2.46-beta.4.1-arm64.zip'))).toBe(true)
  })

  it('装完之后那一份照旧删掉(#5747 本来要做的事没丢)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5846-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.46-beta.4.1-arm64.zip', sha512: 'x', isAdminRightsRequired: false,
    }))
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.46-beta.4.1' })).toBe(true)
    expect(existsSync(join(dir, 'pending'))).toBe(false)
  })

  it.each([
    ['gugu-beta-0.2.46-beta.4.1-arm64.zip', '0.2.46-beta.4.1'],
    ['gugu-beta-0.2.46-beta.4.1-x64.zip', '0.2.46-beta.4.1'],
    // ⚠️ 架构段必须按已知集合锚定,否则 arm64 会被当成预发布段读成「0.2.46-arm64」。
    ['gugu-0.2.46-arm64.zip', '0.2.46'],
    ['gugu-0.2.46.dmg', '0.2.46'],
    ['gugu-beta-Setup-0.2.46-beta.4.1.exe', '0.2.46-beta.4.1'],
  ])('%s → %s', (fileName, version) => {
    expect(versionFromArtifactName(fileName)).toBe(version)
  })

  it.each([['nonsense.zip'], ['gugu-arm64.zip'], [''], [null], [undefined], [42]])(
    '认不出的形状返回 null(%s),交给「有记录就先留着」那条兜住',
    (fileName) => { expect(versionFromArtifactName(fileName)).toBeNull() },
  )

  it('version 字段真的存在时优先用它(手工补过 / 哪天库改了)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-5846-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.46-beta.4.1-arm64.zip', version: '0.2.47',
    }))
    expect(readStagedVersion(dir)).toBe('0.2.47')
  })
})

// @@@diff-base 目录顶层那一份是下一次差分下载的底。原先整目录 rmSync,owner 的 Windows 上
// 61.1/62.1/63.1 三次更新全是 `Cannot download differentially … ENOENT …\gugu-beta-updater\installer.exe`,
// 198MB 整包重下。这里按 electron-updater 6.8.3 / app-builder-lib 26.15.3 的真实文件布局造目录。
describe('@@@diff-base 清 pending 时留着差分下载的底', () => {
  it.each([false, true])('清掉旧版预解压目录,保留差分底和更新的 pending(hasPending=%s)', async (hasPending) => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-extracted-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'staged'))
    writeFileSync(join(dir, 'staged', '.staged-version'), '0.2.58-beta.1032.1')
    writeFileSync(join(dir, 'staged', 'gugu-beta.exe'), 'old extracted app')
    writeFileSync(join(dir, 'installer.exe'), 'base')
    writeFileSync(join(dir, 'current.blockmap'), 'map')
    if (hasPending) {
      mkdirSync(join(dir, 'pending'))
      writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({ version: '0.2.60' }))
      writeFileSync(join(dir, 'pending', 'gugu-0.2.60-x64.exe'), 'new download')
    }
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.59' })).toBe(false)
    await vi.waitFor(() => expect(existsSync(join(dir, 'staged'))).toBe(false))
    expect(existsSync(join(dir, 'installer.exe'))).toBe(true)
    expect(existsSync(join(dir, 'current.blockmap'))).toBe(true)
    expect(existsSync(join(dir, 'pending', 'gugu-0.2.60-x64.exe'))).toBe(hasPending)
  })

  it('Windows NSIS:安装器自己拷来的 installer.exe 与 current.blockmap 留着,装完的那份 pending 删掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-diffbase-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'installer.exe'), 'base')
    writeFileSync(join(dir, 'current.blockmap'), 'map')
    writeFileSync(join(dir, 'pending', 'gugu-beta-0.2.53-beta.63.1-x64.exe'), 'x')
    writeFileSync(join(dir, 'pending', 'current.blockmap'), 'map')
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.53-beta.63.1-x64.exe', sha512: 'x', isAdminRightsRequired: false,
    }))
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.53-beta.63.1' })).toBe(true)
    expect(existsSync(join(dir, 'pending'))).toBe(false)
    expect(existsSync(join(dir, 'installer.exe'))).toBe(true)
    expect(existsSync(join(dir, 'current.blockmap'))).toBe(true)
  })

  it('没有 pending 时什么都不动(底照样在)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-diffbase-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'installer.exe'), 'base')
    expect(purgeStaleUpdaterCache({ cacheDir: dir, runningVersion: '0.2.53-beta.63.1' })).toBe(false)
    expect(existsSync(join(dir, 'installer.exe'))).toBe(true)
  })

  // 126 10-08 Chole 实读:63.1 首次启动的清理撞了 EPERM(刚装完的安装器还攥着 pending 里那个 exe)。
  // 原先整目录 rmSync 时,删得掉的(installer.exe、current.blockmap)先没了、pending 反而留着。
  // 现在只碰 pending/:删不掉就记一行、下次启动再删,底一个都不少。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('pending 删不掉(EPERM 一类)→ 记一行、返回 false,底照样都在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-updcache-diffbase-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'installer.exe'), 'base')
    writeFileSync(join(dir, 'update.zip'), 'base')
    writeFileSync(join(dir, 'current.blockmap'), 'map')
    writeFileSync(join(dir, 'pending', 'gugu-beta-0.2.53-beta.63.1-x64.exe'), 'x')
    writeFileSync(join(dir, 'pending', 'update-info.json'), JSON.stringify({
      fileName: 'gugu-beta-0.2.53-beta.63.1-x64.exe', sha512: 'x', isAdminRightsRequired: false,
    }))
    chmodSync(join(dir, 'pending'), 0o555) // 里面的文件删不掉
    locked.push(join(dir, 'pending'))
    const lines: string[] = []
    expect(purgeStaleUpdaterCache({
      cacheDir: dir, runningVersion: '0.2.53-beta.63.1', log: (message) => lines.push(message),
    })).toBe(false)
    expect(lines.some((l) => l.includes('清更新缓存失败'))).toBe(true)
    expect(existsSync(join(dir, 'installer.exe'))).toBe(true)
    expect(existsSync(join(dir, 'update.zip'))).toBe(true)
    expect(existsSync(join(dir, 'current.blockmap'))).toBe(true)
  })
})
