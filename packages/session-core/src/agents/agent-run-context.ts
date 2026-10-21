import { z } from 'zod';
import { hostCliKey, hostCliSchema } from './host-cli';

/**
 * 「这一家跑起来是什么样」—— 宿主算好的**唯一**答案(#5702)。
 *
 * 一条产品承诺(product spec):
 *
 * > 面板显示哪一份,咕咕就启动哪一份。改了选哪一份,能跑哪些模型、有没有登录,都按新选中的
 * > 那一份重新读。
 *
 * 这条承诺此前被修过三轮(#5548 / #5681 / #5683),每轮的形状都一样:**在一个新的调用点上补一次参数**。
 * 补到第七个调用点时,普查出还有 19 处在违反它 —— 因为「跑哪一份」和「带什么环境」是**两个**解析者,
 * 各自还有主进程/worker 两份实现,一共四个属主,而用户买的是一件事。
 *
 * ⇒ 收敛成一格:主进程算,worker 只能消费。worker 侧**没有**自己算的那一路,忘记带它编译不过。
 *
 * ## 为什么不带 `generation`
 *
 * 曾经想过给它一个代号让各处派生缓存作废。#5605 已经判过这条路:那张「谁改了要记得通知谁」的表
 * 是「写者 × 缓存」那么大,靠注释维护,而且**漏一格就要重启 app 才生效**。现在的约定是
 * **每一份缓存按自己的输入判新鲜**(见 `agents/controller.ts` 的 `setUsedInstallation`),
 * 所以这份上下文**每次现算**,派生缓存用 `agentRunContextKey` 当键 —— 输入变了自然查不中,
 * 没有人需要记得。
 */
export const agentRunContextSchema = z.object({
  /** 选中的那一份二进制(解析失败也是一个答案,带着诊断原文)。 */
  cli: hostCliSchema,
  /** Host-owned credential selection, pinned on first session launch. */
  connectionId: z.string().optional(),
  /** Home-shaped root for reading the selected connection's credential files. */
  credentialHome: z.string().optional(),
  /** Remove inherited authentication before adding the selected credentials. */
  unsetEnv: z.array(z.string()).optional(),
  /** Selected device credentials. Provider/platform overrides remain authoritative. */
  credentialEnv: z.record(z.string(), z.string()).optional(),
  /**
   * 底座 env:白名单透传 + 平台补偿(Windows 八个必备变量 / `SSH_AUTH_SOCK` 探测)
   * + **用户在 Agents 设置里填的 env**。
   *
   * ⚠️ 由宿主用**活的** `process.env` 算出来。worker 自己那份 `process.env` 是 fork 那一刻的快照,
   *    用户改了 PATH / 换了代理之后它还是旧的 —— 那正是「聊天腿连不上、终端腿连得上」的由来。
   */
  env: z.record(z.string(), z.string()),
  /**
   * 咕咕给这一家的**独立配置根**(`configRoot`)。
   *
   * 单独一格是因为它的位置不一样:它必须压过 provider 自己的命令 env,也必须压过用户 export 的
   * 同名变量 —— 分家的前提就是咕咕这份赢。叠放顺序见 `composeAgentSpawnEnv`。
   */
  configRootEnv: z.record(z.string(), z.string()),
  /**
   * 关掉这一家自更新的会话级 env(descriptor 的 `selfUpdate`,#6186)。
   *
   * 放进这一格而不是让各 spawn 点自己读 descriptor:终端腿、聊天(ACP)腿、版本探针都从这份上下文起,
   * 一处算好就全到。它压过用户 export 的同名变量 —— 「咕咕起的会话一律不自更新」是 owner 定的产品合同,
   * 不是可被偏好覆盖的默认值。
   */
  selfUpdateEnv: z.record(z.string(), z.string()),
  /** 用户在 Agents 设置里填的额外参数。此前只有终端腿吃得到。 */
  extraArgs: z.array(z.string()),
  /** 跑这一家需要的运行时(`GUGU_NODE_BIN`);缺省表示用系统的。 */
  runtimeExecutable: z.string().optional(),
  /**
   * 宿主按**这一份 CLI 的版本**配好的 ACP 桥接入口(#6394)。缺省 = 用随包的那一份。
   *
   * 只有「桥接与用户自装、会自更新的 CLI 按版本成对」的那几家会有(claude):桥接版本由咕咕自己的
   * 配对表(`@gugu-acp/compat`)决定,不在安装包里定死 —— 定死正是 #6394 的由来。
   * 在主进程算,理由同 `cli`:配对要读版本、可能要下载,worker 看不见也不该自己做。
   */
  acpAdapterEntry: z.string().optional(),
});

export type AgentRunContext = z.infer<typeof agentRunContextSchema>;

/**
 * 消费侧拿不到可用上下文时的两种答案。
 *
 * `cli-not-found` 带的是**宿主解析器自己的诊断原文**(查过哪些位置、为什么都不算数),
 * ❌ 不是 worker 重新措辞的一句话 —— 用户要按它去修的正是那几个位置。
 */
export type AgentRunContextError =
  | { type: 'unknown-provider'; providerId: string }
  | { type: 'cli-not-found'; providerId: string; message: string };

const KEY_FIELD_SEP = String.fromCharCode(0);
const KEY_ITEM_SEP = String.fromCharCode(1);

/**
 * 派生缓存与在途去重的键。
 *
 * 换了拷贝、改了设置里的 env、改了额外参数,都是**另一次读数** —— ❌ 不许并进上一次的结果,
 * 也❌ 不许命中上一次的缓存。env 参与取键正是 #5683 那类 bug 的判据:同一份 CLI 配不同的
 * `CLAUDE_CONFIG_DIR` 是两个账号。
 */
export function agentRunContextKey(ctx: AgentRunContext): string {
  return [
    hostCliKey(ctx.cli),
    envKey(ctx.env),
    envKey(ctx.configRootEnv),
    envKey(ctx.credentialEnv ?? {}),
    envKey(ctx.selfUpdateEnv),
    ctx.extraArgs.join(KEY_ITEM_SEP),
    ctx.runtimeExecutable ?? '',
    ctx.acpAdapterEntry ?? '',
    ctx.connectionId ?? '',
    ctx.credentialHome ?? '',
    (ctx.unsetEnv ?? []).join(KEY_ITEM_SEP),
  ].join(KEY_FIELD_SEP);
}

function envKey(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join(KEY_ITEM_SEP);
}

/**
 * 一条腿真正要交给子进程的 env —— **唯一**的叠放顺序(#5702)。
 *
 * 从前终端腿与聊天腿各排各的:终端腿把用户设置的 env 排在 provider 命令 env **之上**,
 * 聊天腿反过来。同一台机器上同一个变量,两条腿的取值可以不一样,而且不报错。
 *
 * 低 → 高:
 *
 * 1. `ctx.env` —— 用户 shell 里的白名单变量 + 平台补偿 + 用户在设置里填的 env;
 *    选择连接时先删掉继承的认证变量,再叠 `credentialEnv`。这份本地凭据仍低于平台的显式覆盖。
 * 2. `providerEnv` —— 这一家自己的命令 env(`buildCommand` / `buildSpawn` 返回的)。
 *    它压过用户设置是**故意的**:`CLAUDE_CODE_EXECUTABLE` / `GUGU_CODEX_BIN` 这类值指的正是
 *    「宿主选中的那一份」,用户 export 一个同名变量就能把它顶掉,恰恰是本票要判死的那件事。
 * 3. `ctx.configRootEnv` —— 咕咕给这一家的独立配置根;分家的前提就是咕咕这份赢。
 *    `ctx.selfUpdateEnv` 同层 —— 关自更新的会话级开关,同样必须赢过用户与 provider。
 * 4. `hostInjections` —— 每次调用才有的宿主注入:工作区信任、平台中转/能力包、
 *    任务级变量、钩子端口。它压在最上面(理由见 #2503:宿主的注入不是用户偏好)。
 */
export function composeAgentSpawnEnv(
  ctx: AgentRunContext,
  layers: {
    providerEnv?: Record<string, string> | undefined;
    hostInjections?: readonly (Record<string, string> | undefined)[];
  } = {}
): Record<string, string> {
  const env: Record<string, string> = {
    ...ctx.env,
  };
  for (const key of ctx.unsetEnv ?? []) delete env[key];
  Object.assign(env, ctx.credentialEnv, layers.providerEnv, ctx.configRootEnv, ctx.selfUpdateEnv);
  for (const injection of layers.hostInjections ?? []) {
    if (injection) Object.assign(env, injection);
  }
  return env;
}

