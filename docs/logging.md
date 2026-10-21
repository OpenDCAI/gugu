# 日志(主进程)

结构化日志基座在 `apps/desktop/electron/lib/logger.ts`,底层 **pino**(与会话页同引擎,两边的行能合并成一条时间线查)。

## 用法

```ts
import { createLogger } from './lib/logger'
const log = createLogger('acp-host')          // scope = 排障时的过滤键

log.info({ key, reason, idleSec: 12 }, '回收 ACP 会话')   // ✅ 量放字段,消息只留人话
log.warn({ err: e.message }, '回收时停止会话失败')
```

❌ 别写 `log.info('回收会话:', key)` —— pino 的第二个参数不是 printf 的补位,会被丢掉。

## 在哪看

- 文件:`<userData>/logs/gugu-main.log`(启动时那条「日志已就绪」里打了完整路径),单文件 5MB 轮转、保留 3 份。
- 终端:dev 下同时打人话(`12:34:56 INFO [scope] 消息 {字段}`);生产要开加 `GUGU_LOG_STDOUT=1`。
- 级别:`GUGU_LOG_LEVEL=debug|info|warn|error`(dev 默认 debug,生产默认 info)。
- 目录改位置:`GUGU_LOG_DIR=/some/dir`(单测和脚本用这个,logger 本身不认识 electron)。

过滤:

```bash
jq -c 'select(.scope | startswith("sessionpage"))' ~/Library/Application\ Support/gugu/logs/gugu-main.log
jq -c 'select(.level >= 40)' gugu-main.log            # warn 及以上
pnpm exec pino-pretty < gugu-main.log                 # 人话查看历史文件
```

## renderer 侧

```ts
import { rendererLogger } from '@/lib/log'
const log = rendererLogger('chat/input')      // 落盘时 scope = renderer/chat/input
log.warn({ chatId }, '发送失败')
```

经 IPC `log:write` 回传主进程,和主进程日志同一份文件、同一套脱敏。web 目标(无 `electronAPI`)退化打 console。
回传是 fire-and-forget —— 日志失败绝不影响 UI。

渲染层的未捕获错误/`unhandledrejection`/`console.error` 自动回传(scope `renderer/error-ring`,每 10s 限 20 条)。
挂钩在 `lib/errorCaptureBootstrap.ts`,必须是 `main.tsx` 的**第一个 import**:ES 模块先把整张导入图求值完
才执行函数体,晚一步就盖不住「启动期模块求值就抛」——而那正是最要命的一类(白屏)。实测缺 `VITE_SUPABASE_*`
时,以前是白屏 + 零证据,现在日志里有确切原因。**❌ 别把它改成函数调用、也别往下挪。**

## 三条硬纪律

1. **落盘前脱敏**。字段名命中 `token|secret|password|authorization|api_key|service_role` → 整值打码;自由文本里的
   JWT / `sk-…` / `Bearer …` 也打码 —— 密钥经常是拼在 URL 或错误消息里的,只做字段级 redact 挡不住。
2. **日志不许把 app 弄崩**。目录建不出来 → 退化成只打 stdout 并说明原因;循环引用 → `«circular»`;
   超深嵌套 → `«too-deep»`(否则在 pino 的 hook 里爆栈,而那处没有 try = 一条日志打挂调用方);
   写 stdout 用 `writeSync(1)`,❌ 不走 `process.stdout.write`(宿主/测试框架会替换它,在自定义流里回调它会死锁 —— 实测在 vitest 下整个用例挂住)。
3. **目录是迟到的,别丢启动那几行**。`acp-host.ts` / `acp-bridge-impl.ts` 在**模块级**就 `createLogger(...)`,
   而 main.ts 要等 `app.setPath('userData')` 才知道目录 —— import 求值早于导入方的函数体,"没目录"那次 init 必然先跑。
   所以 `initLogging` ❌ 不能幂等早退(早期版本这么写 → 整个 app 一行都不落盘,还一声不响):
   文件迟到期间先在内存攒(256KB 上限),目录一到补写进去。**启动崩溃恰恰发生在这一段。**

落盘走**同步** `writeSync(fd)`,❌ 不用 `createWriteStream`:它的 open 是异步的,一串日志同步刷完时文件还没建
→ 轮转的 `renameSync` 报 ENOENT 被吞、轮转形同没做(实测踩过)。轮转在**运行期**也守 —— 只在启动时轮转的话,
常开好几天的 app 里「5MB」就是句假话。

## 存量 `console.*`

启动时 `installConsoleBridge()` 把 `console.*` 接进日志(scope=`console`),所以**近百处旧调用现在就已经落盘、有级别、过脱敏**。
调用点按需增量改成 `createLogger(scope)` 的结构化形式(范式见 `acp-host.ts` 的 `回收 ACP 会话`)——❌ 不要为了迁移而机械替换,
多参数的 `console.error('x:', a, b)` 直译会丢参数。

## core 侧

`packages/core` 不认识 electron,用注入式:`coreLogger('agent/deviceCommandRuntime')` 取,主进程启动时
`setCoreLoggerFactory((scope) => createLogger(\`core/${scope}\`))` 注入真实现;没注入(单测/脚本)退化打 console。

## pino 钉在 9.x

pino 10 在 `require` 期就无条件调 `diagnostics_channel.tracingChannel`,而 **Electron 28 带的是 Node 18.18**
(该 API 到 18.19 才有)→ 打包后主进程一启动 `TypeError: t.tracingChannel is not a function`,整个 app 起不来。
pino 9 对它做了 `typeof` 保护。要抬版本:先跑发版侧的产物启动冒烟(`cd-release.yml` 的 Boot smoke →
`scripts/appimage-boot-smoke.sh`,当年就是这么抓到的),单测和 dev 都照不出来
—— 那两处跑的是 Node 24。单测里有一条钉版本的绊线,会连原因一起报出来。

## 空回合

「回合正常结束、不报错,但 agent 既没输出也没调工具」= 对用户石沉大海,是最难查的一种失败。
`isEmptyTurn()` 命中即 `log.error`(❌ 不 throw:回合本身没错,重投也未必好),排障时 `jq 'select(.msg|test("空回合"))'`。

## 还没做

- 存量 `console.*` 的增量结构化(桥接已让它们落盘,不阻塞)
- 「反馈」入口一键打包日志给用户回传
