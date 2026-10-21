// @@@logging (#2382) - 日志基座的行为契约。最要紧的两条:密钥不许落盘、日志坏了不许让 app 崩。
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLogger,
  currentLogFile,
  switchLogFileForOwner,
  initLogging,
  installConsoleBridge,
  readLogTailForFeedback,
  FEEDBACK_LOG_TAIL_MAX_LINES,
  FEEDBACK_LOG_TAIL_MAX_BYTES,
  redactText,
  redactValue,
  RENDERER_LOG_CHANNEL,
  resetLoggingForTests,
  writeRendererLog,
} from '../../../../apps/desktop/electron/lib/logger'

const freshDir = () => mkdtempSync(join(tmpdir(), 'gugu-log-'))
const readLog = (): string => {
  const f = currentLogFile()
  return f ? readFileSync(f, 'utf8') : ''
}
const flush = () => new Promise((r) => setTimeout(r, 60))
const fileSizeOf = (f: string): number => statSync(f).size

afterEach(() => resetLoggingForTests())

describe('日志脱敏', () => {
  it('自由文本里的密钥形态被打码(它们常拼在 URL / 错误消息里)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghij' // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
    expect(redactText(`Authorization: Bearer ${jwt}`)).not.toContain(jwt)
    expect(redactText('key=sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop')
    expect(redactText('token: "abcdefgh12345678"')).not.toContain('abcdefgh12345678') // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
  })

  it('字段名命中就整值打码,普通字段原样保留', () => {
    const out = redactValue({
      chatId: 'chat-1',
      accessToken: 'abcdefgh12345678', // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
      nested: { SUPABASE_SERVICE_ROLE_KEY: 'zzzz', ok: 42 },
    }) as Record<string, unknown>
    expect(out.chatId).toBe('chat-1')
    expect(out.accessToken).toBe('«redacted»')
    expect((out.nested as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY).toBe('«redacted»')
    expect((out.nested as Record<string, unknown>).ok).toBe(42)
  })

  // @@@4899 这一组补的是「这张表允许有漏网」那句话的**具体漏在哪**。起因是 #4899 想给反馈
  // 加一个「一并上传日志」的勾选框 —— 勾之前得知道日志里到底还剩什么。
  //
  // ⚠ 形状全部**运行时拼**,字面量不入源码:一是别让仓库里躺着长得像真凭据的串(secret
  // scanning / push protection 会拦),二是要证的本来就只是「判据认不认得出这个形状」。
  describe('曾经漏网的几种形状', () => {
    const A36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    const ghClassic = 'gh' + 'p_' + A36
    const ghFine = 'github' + '_pat_' + '11ABCDEFG0' + '_' + 'MnOpQrStUvWxYz0123456789AbCdEfGh'
    const awsId = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const pem = [
      '-----BEGIN ' + 'OPENSSH PRIVATE' + ' KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
      '-----END ' + 'OPENSSH PRIVATE' + ' KEY-----',
    ].join('\n')

    it.each([
      ['GitHub PAT(classic)', `remote: rejected ${ghClassic}`, ghClassic, '«gh-token»'],
      ['GitHub PAT(fine-grained)', `auth error with ${ghFine}`, ghFine, '«gh-token»'],
      ['AWS access key id', `upload denied for ${awsId}`, awsId, '«aws-key»'],
      ['SSH 私钥块(多行)', pem, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '«private-key»'],
    ])('%s 不再明文落盘', (_name, input, secret, placeholder) => {
      const out = redactText(input)
      expect(out).not.toContain(secret)
      expect(out).toContain(placeholder)
    })

    it('连接串里内联的密码被抹,scheme / 用户名 / 主机留着(整条打掉等于把日志写废)', () => {
      const out = redactText('ECONNREFUSED postgresql://postgres:S3cr3tP4ssw0rd@db.example.com:5432/postgres')
      expect(out).not.toContain('S3cr3tP4ssw0rd')
      // 「连哪台、以谁的身份」正是排查要看的 —— 这半句必须活着,否则这条规则就从脱敏
      // 变成了删日志。
      expect(out).toContain('postgresql://postgres:')
      expect(out).toContain('@db.example.com:5432/postgres')
    })

    // ⚠ 我本来想在这里钉「私钥规则必须排在表首」。变异了一次:把它挪到表尾,这条照绿 ——
    // 现有规则都够不着 PEM 的 base64 块体,顺序当前不影响结果。⇒ 那个断言是**判不出来**的,
    // 与其留一条平凡真冒充哨兵,不如把它降级成源码里一句写明「未验证」的注释。
    // 这条留下来的是真能判的那半:整块跨行内容被吃掉,而同一行里别的密钥照样各归各的规则。
    it('私钥块整块被吃掉,与同串里的其它密钥互不干扰', () => {
      const out = redactText(`${pem}\nAuthorization: Bearer abcdefghijklmnopqrst`)
      expect(out).toContain('«private-key»')
      expect(out).not.toContain('-----BEGIN')
      expect(out).toContain('«token»')
    })

    it('argv 里「开关 + 值」被劈成两个元素时也打码(关键词规则天生够不着这个形状)', () => {
      const out = redactValue(['gh', 'auth', 'login', '--with-token', ghClassic]) as string[]
      expect(out).toEqual(['gh', 'auth', 'login', '--with-token', '«redacted»'])
    })

    it('❌ 不抹 --key / -i 这类开关的值:那是文件路径,不是秘密,抹了排查线索就没了', () => {
      const out = redactValue(['ssh', '-i', '/home/u/.ssh/id_ed25519', 'host']) as string[]
      expect(out).toEqual(['ssh', '-i', '/home/u/.ssh/id_ed25519', 'host'])
    })

    // redactText 挂在 pino 的 hook 上,**每行日志都过**。所以一条规则在长行上的
    // 回溯代价不是「测试慢」,是**主进程会被一条长堆栈冻住**。
    // 实测:scheme 写成 `[a-z][a-z0-9+.-]*` 时,一条 64KB 的行要 11 秒(其余八条规则全是
    // 亚毫秒 —— 那就是阳控,证明慢的是那一条不是机器)。加上长度上限后 8.4ms。
    // ⇒ 这条用超时当判据:退回无上限写法,它会在 2s 内红。这不是跟别的进程赛跑,
    //   是我们自己这个同步函数的确定性 CPU 上界。
    it('长行不会把脱敏拖垮(回溯爆炸 = 主进程被一条长堆栈冻住)', () => {
      const line = `{"n":0,"blob":"${'x'.repeat(64 * 1024)}"}`
      const out = redactText(line)
      // 顺带钉住「别为了快把规则改废」:同一次调用里,真连接串仍要被抹。
      expect(out).toHaveLength(line.length)
      expect(redactText('postgresql://postgres:S3cr3tP4ssw0rd@db.example.com:5432/x'))
        .not.toContain('S3cr3tP4ssw0rd')
    }, 2000)

    it('【阴控】不含密钥的普通句子一个字节都不动', () => {
      // 没有这条,上面每一条都可能是「把什么都抹了」的平凡真。
      const plain = 'chat snapshot unavailable for conversation 42 at https://db.example.com/rest/v1'
      expect(redactText(plain)).toBe(plain)
    })
  })

  it('循环引用不炸(日志不该成为崩溃源)', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(() => redactValue(a)).not.toThrow()
  })

  // 递归无上限的话,深层嵌套对象会在 pino 的 hook 里爆栈 —— 而那处没有 try,等于一条日志把调用方打挂。
  it('超深嵌套截断而不爆栈(renderer 回传/三方错误对象都可能很深)', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 5000; i += 1) deep = { next: deep }
    expect(() => redactValue(deep)).not.toThrow()
    expect(JSON.stringify(redactValue(deep))).toContain('«too-deep»')
  })

  it('落盘的那一行里没有明文密钥', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    createLogger('t').info({ accessToken: 'abcdefgh12345678' }, '带着 sk-abcdefghijklmnop 上路') // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
    await flush()
    const text = readLog()
    expect(text).not.toContain('abcdefgh12345678')
    expect(text).not.toContain('sk-abcdefghijklmnop')
    expect(text).toContain('«redacted»')
  })
})

// @@@4899 用户在反馈里勾了「附带日志」才走这条。
describe('附带进反馈的日志尾巴', () => {
  const A36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const ghClassic = 'gh' + 'p_' + A36
  const appendRaw = (line: string) => appendFileSync(currentLogFile() as string, `${line}\n`)

  it('把**已经躺在盘上的**旧行也重新脱敏一遍 —— 这是这条读取路径存在的理由', () => {
    // 写入侧脱敏用的是**写那一刻**的规则表。#4899 之前的表漏 GitHub PAT,所以用户机器上
    // 早就落了明文的历史行。这里绕过 logger 直接往文件里追加,模拟的正是那种行 ——
    // ❌ 不能用 createLogger 写,那样写进去的本来就已经脱敏,这条断言就成了平凡真。
    initLogging({ dir: freshDir(), stdout: false })
    appendRaw(`{"msg":"remote rejected ${ghClassic}"}`)
    expect(readFileSync(currentLogFile() as string, 'utf8')).toContain(ghClassic) // 盘上确实是明文
    expect(readLogTailForFeedback().text).not.toContain(ghClassic)               // 交出去的不是
  })

  it('【阴控】不含密钥的行一个字节都不动', () => {
    initLogging({ dir: freshDir(), stdout: false })
    appendRaw('{"msg":"chat snapshot unavailable"}')
    expect(readLogTailForFeedback().text).toContain('{"msg":"chat snapshot unavailable"}')
  })

  it(`只带最近 ${FEEDBACK_LOG_TAIL_MAX_LINES} 行,且带的是**尾巴**不是开头`, () => {
    initLogging({ dir: freshDir(), stdout: false })
    for (let i = 0; i < FEEDBACK_LOG_TAIL_MAX_LINES + 500; i += 1) appendRaw(`{"n":${i}}`)
    const tail = readLogTailForFeedback()
    expect(tail.lines).toBe(FEEDBACK_LOG_TAIL_MAX_LINES)
    expect(tail.truncated).toBe(true)
    expect(tail.text).toContain(`{"n":${FEEDBACK_LOG_TAIL_MAX_LINES + 499}}`) // 最后一行在
    expect(tail.text).not.toContain('{"n":0}')                                // 第一行不在
  })

  it('行数没到顶、字节到顶也要裁 —— 单行是没有长度上限的(整个 stack 可能在一行里)', () => {
    initLogging({ dir: freshDir(), stdout: false })
    const fat = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i += 1) appendRaw(`{"n":${i},"blob":"${fat}"}`) // 20 行 > 512KB,远不到 2000 行
    const tail = readLogTailForFeedback()
    expect(tail.lines).toBeLessThan(20)
    expect(tail.bytes).toBeLessThanOrEqual(FEEDBACK_LOG_TAIL_MAX_BYTES)
    expect(tail.truncated).toBe(true)
  })

  it('没有日志文件就抛 —— ❌ 不许悄悄给一个空的(用户以为给了线索,排查方以为用户没日志)', () => {
    resetLoggingForTests()
    expect(() => readLogTailForFeedback()).toThrow()
  })
})

describe('日志基座能在 Electron 的 Node 基线上起来', () => {
  // 实测代价:pino 10 在 `require` 期就无条件调 `diagnostics_channel.tracingChannel`,
  // 而 Electron 28 带的是 Node 18.18(该 API 到 18.19 才有)—— 打包后主进程一启动就
  // `TypeError: t.tracingChannel is not a function`,整个 app 起不来(打包冒烟抓到)。
  // pino 9 对它做了 `typeof` 保护,所以钉在 9.x。要往上抬版本:先跑 cd-release.yml 的 Boot smoke
  //(scripts/appimage-boot-smoke.sh)确认打包能起。
  const req = createRequire(import.meta.url)

  it('pino 钉在 9.x(❌ 10.x:无保护地用 Node ≥18.19 的 API)', () => {
    const { version } = req('pino/package.json') as { version: string }
    expect(Number(version.split('.')[0])).toBe(9)
  })

  it('pino 对 tracingChannel 有存在性保护(这条保护没了 = Node 18 上必崩)', () => {
    const tools = readFileSync(req.resolve('pino/lib/tools.js'), 'utf8')
    expect(tools).toMatch(/typeof\s+\w+\.tracingChannel\s*===\s*'function'/)
  })
})

describe('日志基座', () => {
  // #4277 日志按账号分文件:登录确立后写 users/<id>/,启动段留在根文件,两边各有一行指路。
  it('按账号切文件:之后的行写进 users/<id>/gugu-main.log,根文件留一行指路,退出切回根文件', async () => {
    const dir = freshDir()
    initLogging({ dir, stdout: false })
    const rootFile = currentLogFile() as string
    createLogger('t').info('before-login')

    const userFile = switchLogFileForOwner('user-A')
    expect(userFile).toBe(join(dir, 'users', 'user-A', 'gugu-main.log'))
    expect(currentLogFile()).toBe(userFile)
    createLogger('t').info('after-login')
    await new Promise((r) => setTimeout(r, 20))

    const rootText = readFileSync(rootFile, 'utf8')
    const userText = readFileSync(userFile as string, 'utf8')
    expect(rootText).toContain('before-login')
    expect(rootText, '根文件要留一行指路').toContain('users/user-A')
    expect(rootText, '登录后的行不再进根文件').not.toContain('after-login')
    expect(userText).toContain('after-login')
    expect(userText, '账号文件要说明从哪接续').toContain('接续')

    // 同一账号再切 = 幂等;切回 null = 回根文件
    expect(switchLogFileForOwner('user-A')).toBe(userFile)
    expect(switchLogFileForOwner(null)).toBe(rootFile)
    createLogger('t').info('after-logout')
    await new Promise((r) => setTimeout(r, 20))
    expect(readFileSync(rootFile, 'utf8')).toContain('after-logout')
  })

  it('没落盘时切账号是 no-op,返回 null', () => {
    resetLoggingForTests()
    initLogging({ stdout: false })
    expect(switchLogFileForOwner('user-A')).toBeNull()
  })

  it('每行是 JSON,带 scope / level / 时间戳(能用 jq 过滤)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    createLogger('sessionpage/deliver').warn({ agent: 'a1' }, '投递被踢,重发')
    await flush()
    const line = JSON.parse(readLog().trim().split('\n').pop() as string)
    expect(line.scope).toBe('sessionpage/deliver')
    expect(line.msg).toBe('投递被踢,重发')
    expect(line.agent).toBe('a1')
    expect(line.level).toBe(40)
    expect(typeof line.time).toBe('number')
  })

  it('级别可调:info 级别下 debug 不落盘', async () => {
    initLogging({ dir: freshDir(), stdout: false, level: 'info' })
    const log = createLogger('t')
    log.debug('看不见我')
    log.info('看得见我')
    await flush()
    expect(readLog()).not.toContain('看不见我')
    expect(readLog()).toContain('看得见我')
  })

  // app 常开好几天,一个爱说话的 agent 循环能把单文件写到几个 G —— 只在启动时轮转 = 「5MB 轮转」是句假话,
  // 最后是用户的磁盘替我们兜。所以上限必须在**运行期**也守住。
  it('运行期写超上限也会轮转(❌ 只在启动时轮转 = 长开的 app 无限长)', async () => {
    const dir = freshDir()
    initLogging({ dir, stdout: false, maxBytes: 4096 })
    const log = createLogger('t')
    for (let i = 0; i < 60; i += 1) log.info({ i, pad: 'x'.repeat(200) }, '话多的一行')
    await flush()
    expect(readdirSync(dir)).toContain('gugu-main.log.1')
    expect(fileSizeOf(join(dir, 'gugu-main.log'))).toBeLessThan(4096 * 2)
  })

  it('文件超限会轮转,历史保留为 .1(日志不无限长)', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'gugu-main.log'), 'x'.repeat(6 * 1024 * 1024))
    initLogging({ dir, stdout: false })
    createLogger('t').info('轮转之后的第一行')
    await flush()
    const files = readdirSync(dir).sort()
    expect(files).toContain('gugu-main.log.1')
    expect(readLog()).toContain('轮转之后的第一行')
    expect(readLog().length).toBeLessThan(1024 * 1024)
  })

  it('存量 console.* 经桥接后照样落盘、照样脱敏(不用等逐个改完)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    const restore = installConsoleBridge()
    try {
      console.warn('旧代码在喊', { accessToken: 'abcdefgh12345678' }) // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
    } finally {
      restore()
    }
    await flush()
    const line = JSON.parse(readLog().trim().split('\n').pop() as string)
    expect(line.scope).toBe('console')
    expect(line.level).toBe(40)
    expect(line.msg).toBe('旧代码在喊')
    expect(JSON.stringify(line.args)).not.toContain('abcdefgh12345678')
    expect(console.warn.name).not.toBe('')
  })

  // 实测一次真运行 85 行里 82 行是 scope=console(#2391)→「按 scope 过滤」等于没用。
  // 行首已有的 `[域]` 前缀就是现成的分流依据,比逐个改调用点便宜得多。
  it('console 桥接按行首前缀分 scope(存量行也能按域过滤)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    const restore = installConsoleBridge()
    try {
      console.log('[sessionpage] boot OK — session page backend serving')
      console.warn('[device-runtime] command wake subscribe failed')
      console.log('没有前缀的老代码')
    } finally {
      restore()
    }
    await flush()
    const scopes = readLog().trim().split('\n').map((l) => JSON.parse(l).scope)
    expect(scopes).toContain('console/sessionpage')
    expect(scopes).toContain('console/device-runtime')
    expect(scopes).toContain('console')
  })

  // ❌ 别剥掉消息里的前缀:产物启动冒烟的断言 grep 的就是 stdout 里的 `[sessionpage] boot OK`
  //(scripts/appimage-boot-smoke.sh 的日志契约,cd-release.yml 在跑)。剥了发版当场红 —— 这条守住那个契约。
  it('分了 scope 也不动消息原文(冒烟脚本 grep 的就是原文)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    const restore = installConsoleBridge()
    try {
      console.log('[sessionpage] boot OK — session page backend serving')
    } finally {
      restore()
    }
    await flush()
    expect(JSON.parse(readLog().trim().split('\n').pop() as string).msg)
      .toBe('[sessionpage] boot OK — session page backend serving')
  })

  it('console 桥接遇到循环引用不抛(❌ 把原本无害的 console.log 变成崩溃源)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    const restore = installConsoleBridge()
    const circular: Record<string, unknown> = { name: 'x' }
    circular.self = circular
    try {
      expect(() => console.log(circular)).not.toThrow()
      expect(() => console.error('前缀', circular)).not.toThrow()
    } finally {
      restore()
    }
    await flush()
    expect(readLog()).toContain('«circular»')
  })

  it('renderer 回传:落进同一份文件,scope 带 renderer/ 前缀', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    writeRendererLog({
      scope: 'error-ring',
      level: 'error',
      msg: 'TypeError: Failed to fetch',
      fields: {
        kind: 'error',
        stack: 'TypeError: Failed to fetch\n    at fetchMessages (chat.ts:42:7)',
        source: 'https://app.example/chat.ts:42:7',
      },
    })
    await flush()
    const line = JSON.parse(readLog().trim().split('\n').pop() as string)
    expect(line.scope).toBe('renderer/error-ring')
    expect(line.level).toBe(50)
    expect(line.kind).toBe('error')
    expect(line.stack).toContain('fetchMessages')
    expect(line.source).toBe('https://app.example/chat.ts:42:7')
  })

  it('renderer 回传是 IPC 端点:形状不对也永不抛(❌ 一条日志把 handler 打挂)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    expect(() => writeRendererLog(null)).not.toThrow()
    expect(() => writeRendererLog('不是对象')).not.toThrow()
    expect(() => writeRendererLog({ scope: 42, level: 'nope', msg: { not: 'a string' } })).not.toThrow()
    await flush()
    // 未知 level 退化成 info、scope 缺失记为 unknown —— 丢弃也要留痕
    const line = JSON.parse(readLog().trim().split('\n').pop() as string)
    expect(line.scope).toBe('renderer/unknown')
    expect(line.level).toBe(30)
  })

  // 这条守的是**真实的启动顺序**,不是理论:部分主进程模块在**模块级**就
  // `const log = createLogger(...)`,而 main.ts 要等 `app.setPath('userData')` 之后才知道日志目录。
  // import 求值早于导入方的函数体 → 无参 initLogging 必然先跑。此前它会先建一个"没有目录"的根 logger,
  // 之后 main.ts 那次 `initLogging({dir})` 撞上幂等早退 → **整个 app 一行都不落盘**,还一声不响。
  it('模块级 createLogger 先跑,main.ts 后给目录也要能补上(❌ 幂等早退把文件吞掉)', async () => {
    const early = createLogger('early') // 模拟模块加载早期,此刻还没人知道目录
    early.info('启动早期的一行')
    const dir = freshDir()
    initLogging({ dir, stdout: false }) // main.ts 拿到 userData 之后才调
    createLogger('late').info('目录给定之后的一行')
    await flush()
    expect(currentLogFile()).not.toBeNull()
    expect(readLog()).toContain('目录给定之后的一行')
    // 早期那几行也要补进文件 —— 启动崩溃恰恰爱发生在这一段,丢了等于白做
    expect(readLog()).toContain('启动早期的一行')
  })

  it('目录建不出来 → 退化成只打 stdout,不抛(❌ 日志把 app 弄崩)', () => {
    // 在一个**普通文件**下面建子目录 → 必然 ENOTDIR。
    // ❌ 别拿 /proc 下的路径当"不可写":这台机器上 root 对 procfs 的 mkdir 会直接挂住(排查花了几轮)。
    const file = join(freshDir(), 'a-file')
    writeFileSync(file, 'x')
    expect(() => initLogging({ dir: join(file, 'sub'), stdout: false })).not.toThrow()
    expect(currentLogFile()).toBeNull()
  })
})

// —— code review(#2384)揪出来的几条,各配一根绊线 ——
describe('review 揪出的回归点', () => {
  it('debug 档位是活的(multistream 的每条流都要带 level,否则 pino 默认 info → debug 全丢)', async () => {
    initLogging({ dir: freshDir(), stdout: false, level: 'debug' })
    createLogger('t').debug('这条 debug 必须落盘')
    await flush()
    expect(readLog()).toContain('这条 debug 必须落盘')
  })

  it('Date / Buffer / Map 不被 Object.entries 拍平(时间戳没了、buffer 变百万个键)', () => {
    const out = redactValue({ at: new Date('2026-07-26T00:00:00Z'), buf: Buffer.from('hello'), m: new Map([['a', 1]]) }) as Record<string, unknown>
    expect(out.at).toBe('2026-07-26T00:00:00.000Z')
    expect(out.buf).toBe('«buffer 5B»')
    expect(JSON.stringify(out.m)).toContain('«map»')
  })

  it('同一个对象被引用两次(DAG,不是环)不该被打成 «circular»', () => {
    const shared = { name: 'session-1' }
    const out = JSON.stringify(redactValue({ a: shared, b: shared }))
    expect(out).not.toContain('«circular»')
    expect(out.match(/session-1/g)?.length).toBe(2)
  })

  it('脱敏里有会抛的 getter 也不能把调用方打挂(它可能正跑在崩溃处理器里)', async () => {
    initLogging({ dir: freshDir(), stdout: false })
    const evil = { get boom(): string { throw new Error('getter 炸了') } }
    expect(() => createLogger('t').error({ evil }, '带毒对象')).not.toThrow()
    await flush()
    expect(readLog()).toContain('«redact-failed»')
  })

  it('renderer 与主进程的 IPC 通道常量必须一致(改一边就红)', async () => {
    const renderer = await import('../../../../apps/desktop/src/lib/log')
    expect(renderer.RENDERER_LOG_CHANNEL).toBe(RENDERER_LOG_CHANNEL)
  })
})
