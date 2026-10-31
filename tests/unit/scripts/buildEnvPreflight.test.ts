import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  activateDbEnv,
  announceActiveDb,
  applyActiveDbEnv,
  BAKE_SCAN_DIRS,
  checkBuildEnv,
  checkTargetHost,
  DB_ENV_KEYS,
  decodeJwtClaims,
  envFileOrder,
  parseEnvFile,
  PRODUCTION_DB_HOST,
  readScriptEnv,
  registryFileFor,
  resetDbAnnounceForTest,
  resolveBuildEnv,
  selectTargetEnv,
  verifyDistBake,
} from '../../../scripts/build/build-env-preflight.mts'

const tempDirs: string[] = []
function tempEnvDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-env-preflight-'))
  tempDirs.push(dir)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

// 真 vite 的 loadEnv 在子进程里跑：仓库默认测试环境是 jsdom，而 jsdom 的 TextEncoder 会让
// esbuild 在 import vite 时直接拒跑（`encode('') instanceof Uint8Array === false`），与被测代码无关。
// 换子进程既拿到 ground truth，又不必给这一个文件改共享 setup。
const repoRoot = path.resolve(__dirname, '../../..')
function viteLoadEnv(mode: string, dir: string, shellEnv: Record<string, string> = {}): Record<string, string> {
  // vitest.config.ts 会往 process.env 注 VITE_SUPABASE_*，子进程会继承 —— 那本身就是「shell 压过
  // 文件」的实证，但会污染断言，所以默认剥掉所有 VITE_*，要测 shell 覆盖时再显式传进来。
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')))
  const code = `import {loadEnv} from 'vite';process.stdout.write(JSON.stringify(loadEnv(${JSON.stringify(mode)},${JSON.stringify(dir)},'VITE_')))`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...inherited, ...shellEnv },
  })
  if (run.status !== 0) throw new Error(`vite loadEnv 子进程失败: ${run.stderr}`)
  return JSON.parse(run.stdout)
}

const script = path.join(repoRoot, 'scripts/build/build-env-preflight.mts')
function runCli(args: string[], cwd: string, shellEnv: Record<string, string>) {
  // 剥掉 VITE_*/GUGU_*：vitest.config.ts 注了假的 Supabase 值，继承进来会污染断言。
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_') && !k.startsWith('GUGU_'))
  )
  const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...base, ...shellEnv } })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

const slot = (value: string, source: string | null = '.env.local') => ({ value, source })
const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('vite cascade 顺序（防漂移）', () => {
  // 本模块的全部结论都建立在「.env.local 在所有 mode 下加载，且 mode 文件只覆盖它显式写了的键」
  // 之上。这条如果被 vite 改掉，本文件的诊断就会开始说谎——所以拿真 loadEnv 钉住，而不是信文档。
  test('mode 文件只覆盖自己写了的键，漏写的键静默落回 .env.local', () => {
    const dir = tempEnvDir({
      '.env': 'VITE_URL=from-env\nVITE_KEY=from-env\n',
      '.env.local': 'VITE_URL=from-env-local\nVITE_KEY=from-env-local\n',
      '.env.production': 'VITE_URL=from-env-production\n',
    })
    expect(viteLoadEnv('production', dir)).toEqual({
      VITE_URL: 'from-env-production',
      VITE_KEY: 'from-env-local', // ← 半套覆盖：拆分 .env 文件反而制造的错配
    })
  })

  test('envFileOrder 与 vite 实际加载的文件集一致', () => {
    expect(envFileOrder('production')).toEqual(['.env', '.env.local', '.env.production', '.env.production.local'])
    const dir = tempEnvDir(Object.fromEntries(envFileOrder('production').map((n, i) => [n, `VITE_X=v${i}\n`])))
    // 最后一个文件最强：证明我们的顺序（弱→强）与 vite 的合并方向一致。
    expect(viteLoadEnv('production', dir).VITE_X).toBe('v3')
  })

  // 通路 A 的最后一跳。resolveBuildEnv 里「shell 一旦定义就赢，哪怕空串」是照这个行为写的，
  // 所以也拿真 vite 钉住 —— 空串那条尤其反直觉，是「export 了个空值把好值抹掉」的成因。
  test('shell env 压过所有 .env 文件，空串同样压得住', () => {
    const dir = tempEnvDir({ '.env.local': 'VITE_X=from-file\n', '.env.production': 'VITE_X=from-mode-file\n' })
    expect(viteLoadEnv('production', dir, { VITE_X: 'from-shell' }).VITE_X).toBe('from-shell')
    expect(viteLoadEnv('production', dir, { VITE_X: '' }).VITE_X).toBe('')
  })
})

describe('resolveBuildEnv', () => {
  const envFiles = [
    { name: '.env', values: { VITE_SUPABASE_URL: 'https://weak.example', VITE_SUPABASE_ANON_KEY: 'weak' } },
    { name: '.env.local', values: { VITE_SUPABASE_URL: 'https://local.example', VITE_SUPABASE_ANON_KEY: 'localkey' } },
  ]

  test('cascade 里靠后的文件赢，来源如实标注', () => {
    const r = resolveBuildEnv({ envFiles, processEnv: {} })
    expect(r.renderer.url).toEqual({ value: 'https://local.example', source: '.env.local' })
  })

  test('shell env 压过所有 .env 文件', () => {
    const r = resolveBuildEnv({ envFiles, processEnv: { VITE_SUPABASE_URL: 'https://shell.example' } })
    expect(r.renderer.url).toEqual({ value: 'https://shell.example', source: 'shell env' })
  })

  test('shell 里导出的空串同样压过文件（#2710 形状，不能当作未设置）', () => {
    const r = resolveBuildEnv({ envFiles, processEnv: { VITE_SUPABASE_URL: '' } })
    expect(r.renderer.url).toEqual({ value: '', source: 'shell env' })
  })

  test('烘焙通路只看 shell，.env 文件对它完全无效', () => {
    const r = resolveBuildEnv({ envFiles, processEnv: {} })
    expect(r.baked.url).toEqual({ value: '', source: null })
  })

  test('烘焙通路的 GUGU_ 优先、空串按 || 继续下落到 VITE_', () => {
    expect(
      resolveBuildEnv({ processEnv: { GUGU_SUPABASE_URL: 'https://g.example', VITE_SUPABASE_URL: 'https://v.example' } })
        .baked.url.value
    ).toBe('https://g.example')
    expect(
      resolveBuildEnv({ processEnv: { GUGU_SUPABASE_URL: '', VITE_SUPABASE_URL: 'https://v.example' } }).baked.url.value
    ).toBe('https://v.example')
  })
})

describe('checkBuildEnv', () => {
  const ok = { url: slot('https://a.example'), anonKey: slot(jwt({ role: 'anon' })) }

  test('两条通路指向不同的库 → error（本 issue 的主犯）', () => {
    const { errors } = checkBuildEnv({
      renderer: ok,
      baked: { url: slot('https://b.example', 'shell env GUGU_SUPABASE_URL'), anonKey: ok.anonKey },
    })
    expect(errors.some((e) => e.includes('不一致'))).toBe(true)
  })

  test('两条通路一致 → 无 error（CD 现状：只经 shell 注入 VITE_*）', () => {
    const processEnv = { VITE_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`, VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon' }) }
    const resolved = resolveBuildEnv({ envFiles: [], processEnv })
    expect(checkBuildEnv({ ...resolved, target: 'prod' }).errors).toEqual([])
  })

  test('缺 URL → error（0.2.18 形状）', () => {
    const { errors } = checkBuildEnv({
      renderer: { url: { value: '', source: null }, anonKey: ok.anonKey },
      baked: { url: { value: '', source: null }, anonKey: ok.anonKey },
    })
    expect(errors.some((e) => e.includes('缺失'))).toBe(true)
  })

  test('shell 导出空串把文件值抹掉时，错误信息指认 shell 而不是说「缺失」', () => {
    const { errors } = checkBuildEnv({
      renderer: { url: { value: '', source: 'shell env' }, anonKey: ok.anonKey },
      baked: { url: { value: '', source: null }, anonKey: ok.anonKey },
    })
    expect(errors.some((e) => e.includes('导出为空串'))).toBe(true)
  })

  test('声明 shared-test 却指向生产库 → error', () => {
    const renderer = { url: slot(`https://${PRODUCTION_DB_HOST}`), anonKey: ok.anonKey }
    const { errors } = checkBuildEnv({ renderer, baked: renderer, target: 'shared-test' })
    expect(errors.some((e) => e.includes('生产库'))).toBe(true)
  })

  test('未声明 target → 只 warn，并把即将烘焙的库打出来', () => {
    const { errors, warnings } = checkBuildEnv({ renderer: ok, baked: ok })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.includes('a.example'))).toBe(true)
  })

  test('托管域名下 anon key 的 ref 与 URL 对不上 → error', () => {
    const renderer = { url: slot('https://projecta.supabase.co'), anonKey: slot(jwt({ ref: 'projectb', role: 'anon' })) }
    const { errors } = checkBuildEnv({ renderer, baked: renderer })
    expect(errors.some((e) => e.includes('不是一套'))).toBe(true)
  })

  test('非 JWT 的新式 key 只降级为 warn，❌ 不阻断构建', () => {
    const renderer = { url: slot(`https://${PRODUCTION_DB_HOST}`), anonKey: slot('sb_publishable_abc123') }
    const { errors, warnings } = checkBuildEnv({ renderer, baked: renderer, target: 'prod' })
    expect(errors).toEqual([])
    expect(warnings.some((w) => w.includes('无法离线核对'))).toBe(true)
  })

  test('过期的 anon key → error', () => {
    const renderer = { url: slot('https://a.example'), anonKey: slot(jwt({ role: 'anon', exp: 1 })) }
    expect(checkBuildEnv({ renderer, baked: renderer }).errors.some((e) => e.includes('过期'))).toBe(true)
  })
})

// 咕咕有三套库，一个 .env.local 只装得下一套，另外两套只能靠记 —— 记错就是连错库。
// 三套各存一份是必须的；关键是它们只能「整套激活」，绝不叠加。
describe('selectTargetEnv（三库登记处）', () => {
  const anon = jwt({ role: 'anon' })
  const fullSet = {
    VITE_SUPABASE_URL: 'https://devdb.example:55433',
    VITE_SUPABASE_ANON_KEY: anon,
    GUGU_SUPABASE_URL: 'https://devdb.example:55433',
    GUGU_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: 'srk-dev',
  }

  test('整套注入，两条通路同源', () => {
    const { injected, errors } = selectTargetEnv({ target: 'shared-test', registryValues: fullSet })
    expect(errors).toEqual([])
    expect(injected.VITE_SUPABASE_URL).toBe(injected.GUGU_SUPABASE_URL)
    expect(Object.keys(injected).sort()).toEqual([...DB_ENV_KEYS].sort())
  })

  test('登记文件不存在、shell 也没整套 → error 并说清楚要建哪个、填什么', () => {
    const { errors } = selectTargetEnv({ target: 'local', registryValues: null })
    expect(errors[0]).toContain(registryFileFor('local'))
    expect(errors[0]).toContain('VITE_SUPABASE_URL')
  })

  // 登记处是给人用的便利，不是唯一合法来源。CI 从 secrets 直接注 shell，.envs/ 被 gitignore
  // 不会出现在 runner 上 —— 若这里硬要求文件存在，给 CI 加上 GUGU_DB_TARGET 会让发版道全挂。
  test('登记文件不存在但 shell 已有整套（CI 形态）→ 放行，只做 host 核对', () => {
    const { injected, errors, warnings } = selectTargetEnv({
      target: 'prod',
      registryValues: null,
      shellEnv: { VITE_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`, VITE_SUPABASE_ANON_KEY: anon },
    })
    expect(errors).toEqual([])
    expect(injected).toEqual({})
    expect(warnings.some((w) => w.includes('shell'))).toBe(true)
  })

  test('一套只写了一半 → error（缺哪个都会静默落回别处）', () => {
    const { errors } = selectTargetEnv({
      target: 'prod',
      registryValues: { VITE_SUPABASE_URL: 'https://a.example', VITE_SUPABASE_ANON_KEY: anon },
    })
    expect(errors.some((e) => e.includes('GUGU_SUPABASE_URL'))).toBe(true)
  })

  test('.env.local 里残留库键 → error，因为它是过期副本', () => {
    const { errors } = selectTargetEnv({
      target: 'shared-test',
      registryValues: fullSet,
      localValues: { VITE_SUPABASE_URL: 'https://stale.example', ALIYUN_OSS_BUCKET: 'x' },
    })
    expect(errors.some((e) => e.includes('过期副本'))).toBe(true)
    // 与库无关的键不该被牵连
    expect(errors.some((e) => e.includes('ALIYUN_OSS_BUCKET'))).toBe(false)
  })

  test('shell 里的残留 export 被整套覆盖，且必须说出来（❌ 静默覆盖）', () => {
    const { injected, warnings } = selectTargetEnv({
      target: 'shared-test',
      registryValues: fullSet,
      shellEnv: { GUGU_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}` },
    })
    expect(injected.GUGU_SUPABASE_URL).toBe('https://devdb.example:55433')
    expect(warnings.some((w) => w.includes('已按 shared-test 整套覆盖'))).toBe(true)
  })

  test('乱写的 target 名不静默放行', () => {
    expect(selectTargetEnv({ target: 'staging', registryValues: fullSet }).errors[0]).toContain('只接受')
  })
})

// --migrate 会改写人家装着密钥的 .env.local,回归必须有:搬错/覆盖/丢注释都是真损失。
// @@@script-env-loader 这个函数取代了十一个脚本各自抄的那份十行解析器。它们在三处是**错的**,
// 而这三条正是 vite/dotenv 读 .env.local 的语义 —— 钉住,免得日后有人"修"回手抄版的行为。
describe('readScriptEnv（脚本侧共享 env 读取）', () => {
  // 造一套登记文件；readScriptEnv 只在点名了 target 时才返回内容。
  function withTarget(body: string, target = 'prod') {
    const dir = tempEnvDir({})
    fs.mkdirSync(path.join(dir, '.envs'), { recursive: true })
    fs.writeFileSync(path.join(dir, `.envs/${target}.env`), body)
    return dir
  }

  test('没点名 target → 空对象（不再偷看任何文件）', () => {
    expect(readScriptEnv(withTarget('K=v'), {})).toEqual({})
  })

  test('点名了但文件不存在 → 空对象，不抛', () => {
    expect(readScriptEnv(tempEnvDir({}), { GUGU_DB_TARGET: 'prod' })).toEqual({})
  })

  // 下面三条钉的是与被替换的十一份手抄解析器的**差异**。三处手抄版都是错的，而这三条
  // 正是 vite/dotenv 读 env 文件的语义 —— 钉住，免得日后有人「修」回手抄版的行为。
  test.each([
    { label: 'export prefix', body: 'export GUGU_SUPABASE_URL=https://a.example\n', key: 'GUGU_SUPABASE_URL', expected: 'https://a.example' },
    { label: 'trailing comment', body: 'VITE_SUPABASE_URL=https://a.example # 生产\n', key: 'VITE_SUPABASE_URL', expected: 'https://a.example' },
    { label: 'quoted value with comment', body: 'K="v with space" # note\n', key: 'K', expected: 'v with space' },
  ])('$label follows dotenv parsing semantics', ({ body, key, expected }) => {
    const dir = withTarget(body)
    expect(readScriptEnv(dir, { GUGU_DB_TARGET: 'prod' })[key]).toBe(expected)
  })

  // @@@one-file-per-env 退役不是「读了但不报错」——那会把「你在用上一个环境的残留值」藏起来。
  test('还留着 .env.local → 抛，并给出可照抄的搬迁命令', () => {
    const dir = tempEnvDir({ '.env.local': 'K=v\n' })
    expect(() => readScriptEnv(dir, {})).toThrow(/已退役[\s\S]*--migrate/)
  })
})

describe('--migrate（整份搬走，原地不留）', () => {
  const anon = jwt({ role: 'anon' })
  const localText = [
    '# 我的本地配置',
    'VITE_SUPABASE_URL=https://devdb.example:55433',
    `VITE_SUPABASE_ANON_KEY=${anon}`,
    'ALICE_EMAIL=alice@test.dev',
    '',
    '# 与库无关的',
    'ALIYUN_OSS_BUCKET=gugu-downloads-prod',
  ].join('\n')

  // @@@one-file-per-env 上一版只搬「库相关」的键、其余留在 .env.local，于是两个容器并存，
  // 而其中一个根本没有自动加载路径。一套环境 = 一个文件，就得整份搬、原地删。
  test('整份搬走：库相关与库无关的键都进登记文件', () => {
    const dir = tempEnvDir({ '.env.local': localText })
    const run = runCli(['--migrate', 'shared-test'], dir, {})
    expect(run.status).toBe(0)
    const moved = fs.readFileSync(path.join(dir, '.envs/shared-test.env'), 'utf8')
    expect(moved).toContain('VITE_SUPABASE_URL=')
    expect(moved).toContain('ALIYUN_OSS_BUCKET=gugu-downloads-prod')
    expect(moved).toContain('# 我的本地配置') // 注释与分组原样保留
  })

  test('搬完 .env.local 被删掉 —— 留个空壳会让人以为还没搬', () => {
    const dir = tempEnvDir({ '.env.local': localText })
    expect(runCli(['--migrate', 'prod'], dir, {}).status).toBe(0)
    expect(fs.existsSync(path.join(dir, '.env.local'))).toBe(false)
    expect(fs.existsSync(path.join(dir, '.env.local.bak'))).toBe(true)
  })

  test('只报键名，❌ 不回显密钥', () => {
    const dir = tempEnvDir({ '.env.local': localText })
    const run = runCli(['--migrate', 'shared-test'], dir, {})
    expect(run.out).toContain('VITE_SUPABASE_ANON_KEY')
    expect(run.out).not.toContain(anon)
  })

  test('CLI 搬迁：登记文件已存在时拒绝覆盖', () => {
    const dir = tempEnvDir({ '.env.local': localText })
    fs.mkdirSync(path.join(dir, '.envs'))
    fs.writeFileSync(path.join(dir, '.envs/prod.env'), 'VITE_SUPABASE_URL=https://existing.example\n')
    const run = runCli(['--migrate', 'prod'], dir, {})
    expect(run.status).toBe(1)
    expect(fs.readFileSync(path.join(dir, '.envs/prod.env'), 'utf8')).toContain('existing.example')
  })
})

// 这一组盯的是「谁能读到登记处」。第一版把激活放在构建 wrapper 里，是建立在「构建是唯一
// 消费者」这个错误模型上的：`pnpm dev` 是裸 vite，而 e2e account 工厂 / 集成测试 /
// admin:create-account / seed:yatu-accounts / chpay 探针共用一个 bootstrap(现在是 activateDbEnv)，
// 它只读 .env.local。于是 `GUGU_DB_TARGET=local pnpm dev` 是空操作，搬迁完这些全部失去凭据。
describe('applyActiveDbEnv（node 侧 bootstrap 与 vite 顶层共用的激活入口）', () => {
  const anon = jwt({ role: 'anon' })
  const fullSet = [
    'VITE_SUPABASE_URL=https://devdb.example:55433',
    `VITE_SUPABASE_ANON_KEY=${anon}`,
    'GUGU_SUPABASE_URL=https://devdb.example:55433',
    `GUGU_SUPABASE_ANON_KEY=${anon}`,
    'SUPABASE_SERVICE_ROLE_KEY=srk-dev',
  ].join('\n')

  function withRegistry(target: string, body = fullSet) {
    const dir = tempEnvDir({})
    fs.mkdirSync(path.join(dir, '.envs'), { recursive: true })
    fs.writeFileSync(path.join(dir, `.envs/${target}.env`), body)
    return dir
  }

  test('选中一套 → 整套写进 env，两条通路同源', () => {
    const env: Record<string, string | undefined> = { GUGU_DB_TARGET: 'shared-test' }
    const active = applyActiveDbEnv(withRegistry('shared-test'), env)
    expect(active.source).toBe('.envs/shared-test.env')
    expect(env.VITE_SUPABASE_URL).toBe(env.GUGU_SUPABASE_URL)
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('srk-dev')
  })

  test('activateDbEnv writes the selected target file into process.env', () => {
    const dir = withRegistry('shared-test', 'GUGU_3168_SENTINEL=arrived\n')
    const previous = {
      target: process.env.GUGU_DB_TARGET,
      quiet: process.env.GUGU_DB_QUIET,
      sentinel: process.env.GUGU_3168_SENTINEL,
    }
    process.env.GUGU_DB_TARGET = 'shared-test'
    process.env.GUGU_DB_QUIET = '1'
    delete process.env.GUGU_3168_SENTINEL

    try {
      activateDbEnv(dir)
      expect(process.env.GUGU_3168_SENTINEL).toBe('arrived')
    } finally {
      if (previous.target === undefined) delete process.env.GUGU_DB_TARGET
      else process.env.GUGU_DB_TARGET = previous.target
      if (previous.quiet === undefined) delete process.env.GUGU_DB_QUIET
      else process.env.GUGU_DB_QUIET = previous.quiet
      if (previous.sentinel === undefined) delete process.env.GUGU_3168_SENTINEL
      else process.env.GUGU_3168_SENTINEL = previous.sentinel
    }
  })

  test('shell 里的残留生产地址被整套覆盖', () => {
    const env: Record<string, string | undefined> = {
      GUGU_DB_TARGET: 'shared-test',
      GUGU_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`,
    }
    applyActiveDbEnv(withRegistry('shared-test'), env)
    expect(env.GUGU_SUPABASE_URL).toBe('https://devdb.example:55433')
  })

  test('没声明 target → 空操作，旧的 .env.local 路径不受影响', () => {
    const env: Record<string, string | undefined> = {}
    const active = applyActiveDbEnv(withRegistry('shared-test'), env)
    expect(active).toEqual({ values: {}, source: null, target: null })
    expect(env).toEqual({})
  })

  // @@@db-announce product spec：「未声明时不阻断，但必须把本次将要连的库明确显示
  // 出来 —— 不允许悄悄连上某个库」。此前只有构建道会说话，`pnpm dev` 与八个 node 消费者全程静默。
  describe('announceActiveDb（每条路都得说出连的是哪个库）', () => {
    function announce(dir: string, env: Record<string, string | undefined>) {
      resetDbAnnounceForTest()
      const lines: string[] = []
      const result = announceActiveDb(dir, env, (l) => lines.push(l))
      return { result, lines }
    }

    test('声明了 target → 播报 target、host 与凭据来自哪个文件', () => {
      const { result, lines } = announce(withRegistry('shared-test'), {
        GUGU_DB_TARGET: 'shared-test',
        GUGU_SUPABASE_URL: 'https://devdb.example:55433',
      })
      expect(result?.target).toBe('shared-test')
      expect(result?.host).toBe('devdb.example:55433')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('.envs/shared-test.env')
    })

    // @@@one-file-per-env .env.local 退役后不再兜底读任何文件：未声明 target 时值只可能来自
    // shell（CI 走这条）。此前这里会去偷看 .env.local，那正是「两个容器并存」的一部分。
    test('没声明 target 但 shell 里有地址 → 照播，并提示可以点名', () => {
      const { result, lines } = announce(tempEnvDir({}), { VITE_SUPABASE_URL: 'https://local.example:54321' })
      expect(result?.host).toBe('local.example:54321')
      expect(result?.source).toBe('shell / 登记处')
      expect(lines[0]).toContain('未声明 GUGU_DB_TARGET')
      expect(lines[0]).toContain('local.example:54321')
    })

    test('声明的那套文件不存在 → 说明落回了哪儿，而不是假装选中了', () => {
      const { lines } = announce(tempEnvDir({}), {
        GUGU_DB_TARGET: 'prod',
        GUGU_SUPABASE_URL: 'https://stale.example',
      })
      expect(lines[0]).toContain('.envs/prod.env 不存在')
      expect(lines[0]).toContain('stale.example')
    })

    test('声明的 target 文件不存在且没有 shell 地址 → 直接抛出缺失来源', () => {
      resetDbAnnounceForTest()
      expect(() => announceActiveDb(tempEnvDir({}), { GUGU_DB_TARGET: 'local' }, () => undefined)).toThrow(
        '.envs/local.env',
      )
    })

    test('一个都没有 → 明说会 fail-loud，不闷着', () => {
      const { lines } = announce(tempEnvDir({}), {})
      expect(lines[0]).toContain('没找到库地址')
    })

    test('同一进程只播一次 —— vite.config 与 Playwright config 可能先后都调到', () => {
      const dir = withRegistry('local')
      const env = { GUGU_DB_TARGET: 'local' }
      const { lines } = announce(dir, env)
      expect(lines).toHaveLength(1)
      const again: string[] = []
      expect(announceActiveDb(dir, env, (l) => again.push(l))).toBeNull()
      expect(again).toHaveLength(0)
    })

    test('GUGU_DB_QUIET=1 → 闭嘴（给把 stderr 当数据读的场景留的口）', () => {
      const { result, lines } = announce(withRegistry('local'), { GUGU_DB_TARGET: 'local', GUGU_DB_QUIET: '1' })
      expect(result).toBeNull()
      expect(lines).toHaveLength(0)
    })
  })
})

describe('checkTargetHost（只断言「是不是生产库」）', () => {
  // 回归：共享测试库经 SSH 隧道走 127.0.0.1（e2e/agent/RUNNING.md(#6270 已删)「account 工厂 + 红线只认
  // loopback」）。第一版按「回环=local」判，把 shared-test 的 loopback 判成错，导致文档里那条
  // `GUGU_DB_TARGET=shared-test pnpm build:app` 对所有按标准姿势配置的人都 exit 1。
  test.each([
    ['prod', PRODUCTION_DB_HOST, true],
    ['prod', 'devdb.example:55433', false],
    ['prod', '127.0.0.1:54321', false],
    ['local', '127.0.0.1:54321', true],
    ['local', PRODUCTION_DB_HOST, false],
    ['shared-test', '127.0.0.1:55321', true], // ← 隧道形态，必须放行
    ['shared-test', 'devdb.example:55433', true],
    ['shared-test', PRODUCTION_DB_HOST, false],
  ])('%s + %s', (target, host, expected) => {
    expect(checkTargetHost(target, host) === null).toBe(expected)
  })

  test('未知 target 名不静默放行', () => {
    expect(checkTargetHost('staging', 'a.example')).toContain('只接受')
  })
})

describe('verifyDistBake', () => {
  test('产物里 0 命中 → error（#1972 同型）', () => {
    const { errors } = verifyDistBake({ files: [{ text: 'no host here' }], expectedHost: PRODUCTION_DB_HOST })
    expect(errors[0]).toContain('出现 0 次')
  })

  test('产物里命中 → 放行并计数', () => {
    const text = `a ${PRODUCTION_DB_HOST} b ${PRODUCTION_DB_HOST}`
    expect(verifyDistBake({ files: [{ text }], expectedHost: PRODUCTION_DB_HOST })).toEqual({ hits: 2, errors: [] })
  })

  test('没有可比对的 host 时不假装通过', () => {
    expect(verifyDistBake({ files: [{ text: 'x' }], expectedHost: null }).errors).toHaveLength(1)
  })

  // 整个 dist 一次性读进内存会给已经贴着 V8 堆上限的 Windows 打包道再加一份压力，
  // 所以内容读取必须是逐文件、且命中即退。
  test('逐文件读取且命中即退，不把剩下的产物也读一遍', () => {
    const read: string[] = []
    const files = [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }]
    const result = verifyDistBake({
      files,
      expectedHost: 'db.example',
      readText: (file) => {
        read.push(file.path!)
        return file.path === 'a.js' ? 'x db.example y' : 'nothing'
      },
    })
    expect(result.hits).toBe(1)
    expect(read).toEqual(['a.js']) // b/c 从未被读进内存
  })
})

// 纯函数全绿但 CLI 一跑就 TypeError（report 迭代了烘焙门根本不返回的 warnings）——
// 所以这组按真实调用方式跑脚本本体，红绿两侧都要有样本，否则闸门坏了没人知道。
describe('CLI（与 build:app 同路径调用）', () => {
  const anon = jwt({ role: 'anon' })

  test('CD 形状（shell 注入 VITE_* + 声明 prod）放行', () => {
    const dir = tempEnvDir({})
    const run = runCli([], dir, {
      GUGU_DB_TARGET: 'prod',
      VITE_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`,
      VITE_SUPABASE_ANON_KEY: anon,
    })
    expect(run.status).toBe(0)
  })

  test('通路分裂（shell 的 GUGU_ 与 .env.local 的 VITE_ 指向不同库）中止构建', () => {
    const dir = tempEnvDir({
      '.env.local': `VITE_SUPABASE_URL=https://devdb.example:55433\nVITE_SUPABASE_ANON_KEY=${anon}\n`,
    })
    const run = runCli([], dir, { GUGU_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}` })
    expect(run.status).toBe(1)
    expect(run.out).toContain('不一致')
  })

  test('烘焙门：dist 缺库地址 → 红；含库地址 → 绿', () => {
    const dir = tempEnvDir({})
    fs.mkdirSync(path.join(dir, 'dist'))
    const shellEnv = { VITE_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`, VITE_SUPABASE_ANON_KEY: anon }

    fs.writeFileSync(path.join(dir, 'dist/app.js'), 'console.log(1)')
    expect(runCli(['--verify-dist', 'dist'], dir, shellEnv).status).toBe(1)

    fs.writeFileSync(path.join(dir, 'dist/app.js'), `const u="https://${PRODUCTION_DB_HOST}"`)
    expect(runCli(['--verify-dist', 'dist'], dir, shellEnv).status).toBe(0)
  })

  test('声明了 target 但登记文件不存在 → 中止，且不叠加下游噪声', () => {
    const run = runCli([], tempEnvDir({}), { GUGU_DB_TARGET: 'local' })
    expect(run.status).toBe(1)
    expect(run.out).toContain(registryFileFor('local'))
    expect(run.out).not.toContain('0.2.18') // 下游的「缺失」症状不该淹掉根因
  })

  test('逃生阀放行且明说自担风险', () => {
    const run = runCli([], tempEnvDir({}), { GUGU_SKIP_ENV_PREFLIGHT: '1' })
    expect(run.status).toBe(0)
    expect(run.out).toContain('自担风险')
  })
})

// 这一轮代码审查挖出来的其余真 bug，各钉一条。
describe('审查回归', () => {
  const anon = jwt({ role: 'anon' })

  test('登记处没有、shell 却有的库键 → error（整套覆盖唯一漏风处）', () => {
    const { errors } = selectTargetEnv({
      target: 'shared-test',
      registryValues: {
        VITE_SUPABASE_URL: 'https://devdb.example:55433',
        VITE_SUPABASE_ANON_KEY: anon,
        GUGU_SUPABASE_URL: 'https://devdb.example:55433',
        GUGU_SUPABASE_ANON_KEY: anon,
      },
      shellEnv: { SUPABASE_SERVICE_ROLE_KEY: 'srk-PROD-残留' },
    })
    // 缺 service key 本身要报，shell 里那把盖不住的更要点名
    expect(errors.some((e) => e.includes('盖不住'))).toBe(true)
  })

  // 不是人人都有 service key（gugu-db skill: 「自己有 SUPABASE_SERVICE_ROLE_KEY 的话」）。
  // 把它设成必填会把普通贡献者挡在门外；防「用错某个库的 service」靠的是上面那条遮蔽检查。
  test('service_role 选填：没有它也能过，但 shell 里那把仍会被点名', () => {
    const conn = {
      VITE_SUPABASE_URL: 'https://devdb.example:55433',
      VITE_SUPABASE_ANON_KEY: anon,
      GUGU_SUPABASE_URL: 'https://devdb.example:55433',
      GUGU_SUPABASE_ANON_KEY: anon,
    }
    expect(selectTargetEnv({ target: 'shared-test', registryValues: conn }).errors).toEqual([])
    expect(
      selectTargetEnv({ target: 'shared-test', registryValues: conn, shellEnv: { SUPABASE_SERVICE_ROLE_KEY: 'x' } })
        .errors.some((e) => e.includes('盖不住'))
    ).toBe(true)
  })

  test('parseEnvFile 剥掉行尾注释（否则注释会被整串烘进产物）', () => {
    expect(parseEnvFile('URL=https://x.example # 生产\n').URL).toBe('https://x.example')
    expect(parseEnvFile('Q="https://y.example # 不是注释"\n').Q).toBe('https://y.example # 不是注释')
  })

  test('烘焙门默认扫两个目录：renderer 的 dist 与烘焙 define 落地的 dist-electron', () => {
    expect(BAKE_SCAN_DIRS).toContain('dist')
    expect(BAKE_SCAN_DIRS).toContain('apps/desktop/dist-electron')
  })

  // 关键不是「扫的目录多」，而是**逐个**断言。合成一堆「任一命中就放行」的话，
  // renderer 有、烘焙 define 没有的包照样过关 —— 而通路 B 判不了正是这道门要修的。
  test('逐目录断言：一处有、另一处没有 → 红，且指名是哪一处', () => {
    const dir = tempEnvDir({})
    const anon2 = jwt({ role: 'anon' })
    const host = 'devdb.example:55433'
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'apps/desktop/dist-electron'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'dist/app.js'), `const u="https://${host}"`)
    fs.writeFileSync(path.join(dir, 'apps/desktop/dist-electron/main.js'), 'console.log(1)')
    const env = { VITE_SUPABASE_URL: `https://${host}`, VITE_SUPABASE_ANON_KEY: anon2 }

    const red = runCli(['--verify-dist'], dir, env)
    expect(red.status).toBe(1)
    expect(red.out).toContain('dist-electron')

    // 两处都有 → 绿
    fs.writeFileSync(path.join(dir, 'apps/desktop/dist-electron/main.js'), `const u="https://${host}"`)
    expect(runCli(['--verify-dist'], dir, env).status).toBe(0)
  })

  // vite 加载 config 时给每个文件前置注入 __vite_injected_original_filename，于是被 import 的
  // 文件里的 shebang 不再位于第 0 位，esbuild 报 `Syntax error "!"`，整个 renderer build 挂。
  // 这条守的是整个 vite.config 导入图，不只是本模块。
  test('vite.config 能被 vite 自己加载（导入图里不许有 shebang）', () => {
    const code = `import {loadConfigFromFile} from 'vite';
      await loadConfigFromFile({command:'build',mode:'production'}, 'vite.config.mts', ${JSON.stringify(repoRoot)});
      process.stdout.write('CONFIG_OK')`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    })
    expect(`${run.stdout}${run.stderr}`).toContain('CONFIG_OK')
    expect(run.status).toBe(0)
  })

  test('经软链路径调用时不能静默空操作（realpath）', () => {
    const dir = tempEnvDir({})
    const link = path.join(dir, 'link.mjs')
    fs.symlinkSync(script, link)
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_') && !k.startsWith('GUGU_'))
    )
    const run = spawnSync(process.execPath, [link], { cwd: dir, encoding: 'utf8', env: base })
    // 缺 env 时它必须照常中止；若主模块判定失效，这里会变成 exit 0 且零输出
    expect(run.status).toBe(1)
    expect(`${run.stdout}${run.stderr}`).toContain('build-env-preflight')
  })

  test('gate:bake 不吞选套错误（target 名乱写时不能报「通过」）', () => {
    const dir = tempEnvDir({})
    fs.mkdirSync(path.join(dir, 'dist'))
    fs.writeFileSync(path.join(dir, 'dist/app.js'), `const u="https://${PRODUCTION_DB_HOST}"`)
    const run = runCli(['--verify-dist', 'dist'], dir, {
      GUGU_DB_TARGET: 'staging',
      VITE_SUPABASE_URL: `https://${PRODUCTION_DB_HOST}`,
      VITE_SUPABASE_ANON_KEY: anon,
    })
    expect(run.status).toBe(1)
    expect(run.out).toContain('只接受')
  })

  test('--migrate 不覆盖已有的 .env.local.bak（那是唯一能退回去的东西）', () => {
    const dir = tempEnvDir({
      '.env.local': 'VITE_SUPABASE_URL=https://a.example\n',
      '.env.local.bak': '# 第一次搬迁留下的原件\n',
    })
    const run = runCli(['--migrate', 'local'], dir, {})
    expect(run.status).toBe(1)
    expect(fs.readFileSync(path.join(dir, '.env.local.bak'), 'utf8')).toContain('第一次搬迁')
  })

  test('--migrate 搬出半套时当场警告，不等到下次构建才报', () => {
    const dir = tempEnvDir({ '.env.local': 'VITE_SUPABASE_URL=https://a.example\n' })
    const run = runCli(['--migrate', 'local'], dir, {})
    expect(run.status).toBe(0)
    expect(run.out).toContain('还缺')
    expect(run.out).toContain('GUGU_SUPABASE_URL')
  })
})

describe('parseEnvFile / decodeJwtClaims', () => {
  test('注释、引号、空行', () => {
    expect(parseEnvFile('# c\nA=1\nB="two"\n\nC=\n')).toEqual({ A: '1', B: 'two', C: '' })
  })

  // `export KEY=value` 是 dotenv 支持的写法，而 .env.local 常被人拿去 source，所以真会这么写。
  // 我们不认它 → 键名解析成 "export KEY" → 明明配好的值被报成「缺失」并误拦构建。
  // 与真 vite 对拍，确保两边看到的是同一组键。
  test('认 dotenv 的 `export KEY=` 前缀，且与真 vite 解析一致', () => {
    expect(parseEnvFile('export A=1\nexport  B="two"\nC=3\n')).toEqual({ A: '1', B: 'two', C: '3' })
    const dir = tempEnvDir({ '.env.local': 'export VITE_EXPORTED=yes\n' })
    expect(viteLoadEnv('production', dir).VITE_EXPORTED).toBe('yes')
    expect(parseEnvFile(fs.readFileSync(path.join(dir, '.env.local'), 'utf8')).VITE_EXPORTED).toBe('yes')
  })

  test.each([
    { label: 'publishable key', token: 'sb_publishable_x' },
    { label: 'malformed payload', token: 'a.!!!.c' },
    { label: 'missing token', token: undefined },
  ])('$label returns null instead of throwing', ({ token }) => {
    expect(decodeJwtClaims(token)).toBeNull()
  })
})
