/**
 * 每家 harness 能跑哪些模型 —— 问 harness 自己，走 ACP 协议的正式出口。
 *
 * ## 为什么不是一张手写表
 *
 * 插件里的 `capabilities.models.modelOptions` 是写死的字面量，harness 出了新模型没有任何东西
 * 会提醒你。实测过它错到什么程度：咕咕静态表钉的 `claude-opus-4-8`，在 claude 2.1.229 里
 * **根本不被识别** —— 原样透传、窗口回落 200000；而 harness 自己报的 `opus[1m]` 解析成
 * `claude-opus-5[1m]`、窗口 1000000。owner 看到的「opus4.8 却只有 200k」与「硬编码」是同一个缺陷。
 *
 * ## 为什么是 ACP 而不是各读各的私有格式
 *
 * ACP 规范里模型清单只有一个正式出口：`session/new` 响应中 `category="model"` 的
 * `configOptions`（`initialize` 的 `agentCapabilities` 不带清单，已逐字核对规范）。
 *
 * 上一版给 codex / claude / mistral / antigravity 各写了一套私有读法，被实测证伪：同一台机器上
 * codex 的 `~/.codex/models_cache.json`（client 0.144.6）报 `gpt-5.6`，而真会话报
 * `gpt-5.6-sol/terra/luna`；更糟的是 `gpt-5.6` 这个 id **codex 0.146.0 根本不认识**
 * （`Model metadata not found`，退回 fallback 元数据 = 连窗口都是错的）。
 * 缓存是上一个 CLI 版本留下的，没人刷。私有格式读到的是「某个时刻的快照」，
 * ACP 读到的是「这条会话真正会用的那份」。
 *
 * 附带好处：同一份 `configOptions` 里还有 `thought_level`（推理档位）与 `model_config`
 * （fast mode / context size），咕咕现在也在硬编码它们 —— 同一条路都能拿。
 *
 * ## id 直接可用（逐家验过，每家都带反例对照）
 *
 * 协议给的只有 `value` / `name` / `description` 三个字段，**没有规范名**，所以拿到的常是别名
 * （`default`、`opus[1m]`、`opencode/big-pickle`）。验过它们在咕咕真正使用的通道上可用：
 * - claude `--model opus[1m]` → 解析成 `claude-opus-5[1m]`、窗口 1M（伪造 id 则原样透传、200K）
 * - codex `-m gpt-5.6-sol` → 无 fallback 警告（伪造 id 有）
 * - opencode `--model opencode/big-pickle` → 真跑出回复（`bogus/nope` 报错）
 *
 * ⚠️ `default` 是**相对**别名：它指「harness 当前推荐的那个」，含义会随 harness 升级而变。
 * 这是用户的本意（选「推荐」），不是缺陷 —— 但界面必须把 `description` 一起显示，否则用户
 * 不知道今天选中的到底是谁。
 *
 * ## 探不到就是探不到
 *
 * ❌ 没有「退回静态表」这条路。harness 没装 / 没登录 / 起不来时，就是**没有模型可选**，
 * 界面据此不渲染选择器（owner 拍板）。列一张用户根本跑不了的模型表，正是咕咕红线里的 fake。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec';
import { defaultEngineTreeOps, signalEngineTree } from '@gugu/session-core/acp/node';
import { errorDetail } from '@gugu/session-shared';
import { redactSecrets } from '@gugu/session-shared/logger';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import type { AcpPlatformInjection } from '@gugu/session-core/acp';
import { mergeTrustedSessionMeta } from '../acp/runtime-process/session-meta';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('harness-model-catalog');

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.once('message', () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    });
    channel.port2.postMessage(undefined);
  });
}

/** 一条模型选项。字段就是协议给的那三个 —— 协议没有的，这里也不编。 */
export interface HarnessModelChoice {
  id: string;
  name: string;
  description?: string;
}

/**
 * 协议自报的一条**登录方式**。
 *
 * ⚠️ 它和 `HarnessModelChoice` 是两种东西,❌ 别再共用后者。共用正是 `type`/`args`/`env`
 *    三格被丢掉的原因:那个形状里根本没有位置放它们,于是「厂商在线上告诉我们该怎么登」
 *    被裁成了一个名字,而咕咕转头去手抄一张平行的登录命令表。
 *
 * 出处是 ACP v1 schema 本体(咕咕依赖的 `@agentclientprotocol/sdk` 自带,
 * `dist/schema/types.gen.d.ts` 的 `AuthMethod`):
 *   `AuthMethod = (AuthMethodEnvVar & {type:"env_var"}) | (AuthMethodTerminal & {type:"terminal"}) | AuthMethodAgent`
 *   并注明「When no `type` is present, the method is treated as `agent`」。
 */
export type TerminalAuthLaunch =
  /**
   * 规范的 `type: "terminal"`:用**同一个 agent 程序和基础配置**再起一个交互进程,
   * 把 `args` **追加**在它原有参数之后、把 `env` 覆盖上去(规范原文:「Launch … with same
   * Agent program and base configuration」「Append the method's `args` and apply `env`」)。
   *
   * ⚠️ 「同一个 agent 程序」对 claude/codex **不是那个 CLI**,而是咕咕跑的那个 ACP adapter ——
   *    实测 claude 给的 `args` 是 `['--cli','auth','login','--claudeai']`,`--cli` 这个旗标
   *    只有 adapter 认。拿它去拼 `claude --cli auth login` 是一条不存在的命令。
   */
  | { style: 'append'; args: string[]; env?: Record<string, string> }
  /**
   * copilot 的 `_meta['terminal-auth']` 方言:给的是一条**完整命令行**(`command` + `args`),
   * 不是要追加的参数。实测 @github/copilot 1.0.80 里它由
   * `process.argv[0]` 与 `[...(argv[1] 若像脚本), 'login']` 现算出来。
   *
   * ⚠️⚠️ **接线之前先读这段**:这条 `command` 是厂商自己填的,**不保证是这家自己的程序**。
   *
   * 实测反例(2026-08-27,真起进程,`/tmp/acpprobe/o-mimo-meta1.json` 原始回包):
   * `@mimo-ai/cli` 0.1.13 是 opencode 的逐字节 fork,它自报
   *   `id:"opencode-login"`, `name:"Login with opencode"`,
   *   `_meta['terminal-auth']:{command:"opencode",args:["auth","login"]}`,
   *   连 `agentInfo.name` 都写着 `"OpenCode"`。
   * 而咕咕给 mimocode 起的 CLI 叫 `mimo`(见 `impl/mimocode/index.ts`)—— 也就是说
   * **照它说的做,是把用户支使去登另一家产品的账号**;装了 opencode 的用户会登错账号,
   * 没装的会拿到一句 command not found。(它自己的 `authenticate` 还无条件抛异常。)
   *
   * 对照组(同一批实测,证明这不是普遍现象、不能一刀切拒绝):
   *   · opencode 1.18.23 → `command:"opencode"` = 它**自己**的二进制,合法;
   *   · claude-code-acp 0.16.2 → `command:"node"` + 自家 `claude-agent-sdk/cli.js`,合法。
   *
   * ⇒ 真去起这个终端的那一刀,**必须**先判「这个程序是不是这家自己的」,判不出就只显示、
   *   不给动作。❌ 别把这一层的 `style:'command'` 当成「可以直接执行」的许可 —— 它只是
   *   「厂商这么说的」的忠实转录。护栏没写在这里,是因为本模块刻意只依赖 node 内置
   *   (插件登记表在另一棵依赖树上),而**真正该拦的位置是启动器**,那一刀还没做。
   */
  | { style: 'command'; command: string; args: string[] };

export interface HarnessAuthMethod {
  id: string;
  name: string;
  description?: string;
  /**
   * 判别符。三种各要**完全不同**的下一步动作,❌ 不能合并:
   *  · `agent`   —— agent 自己走完登录,客户端调协议的 `authenticate({methodId})`,不 spawn 任何东西;
   *  · `terminal`—— 客户端用**同一个 agent 程序**再起一个交互进程,append 它给的 `args`、apply `env`,
   *                 退出码 0 即成功。规范明写「Clients MUST NOT send an `authenticate` request
   *                 for a terminal method」;
   *  · `env_var` —— 客户端收集凭据、以环境变量交给 agent(schema 里仍标 UNSTABLE/@experimental)。
   *
   * `unknown` 是协议给了一个我们不认识的 `type`(规范允许自定义类型)。这时**只显示、不动作** ——
   * ❌ 不默认当成 `agent`:那会对着一个我们没读懂的方法发一个协议禁止的请求。
   */
  kind: 'agent' | 'terminal' | 'env_var' | 'unknown';
  /**
   * `terminal` 专属:这次登录**怎么跑**。两种形状语义不同,❌ 不许合并成一个 `args` 数组 ——
   * 一个是追加、一个是整条替换,混了就会拼出一条谁也没说过的命令。
   */
  terminal?: TerminalAuthLaunch;
  /** `env_var` 专属:要向用户收集、再作为环境变量交回去的那些变量。 */
  vars?: { name: string; label?: string; secret?: boolean; optional?: boolean }[];
  /** `env_var` 专属:去哪儿拿这份凭据。 */
  link?: string;
}

/**
 * 一家 harness 的模型目录状态。
 *
 * 四种状态各自对应一种界面表现，❌ 不要合并成「有/没有」：用户需要知道的是「该去装」
 * 还是「该去登录」还是「坏了」，这三件事的下一步动作完全不同。
 */
export type HarnessCatalogState =
  /** 还没探过。界面显示加载中，不是「没有模型」。 */
  | { kind: 'unknown' }
  /**
   * 探到了。`selected` 是 harness 自己当前选中的那个。
   *
   * `efforts` 来自同一份 `configOptions` 里 `category="thought_level"` 那一项（claude 的
   * `effort`、codex 的 `reasoning_effort`）。⚠️ 协议把它给成**会话级**而不是每模型一份，所以
   * 这里也只有一份 —— ❌ 不要伪装成 per-model：那会编出一个协议没说过的事实。
   *
   * 带上它是因为不带就是退化：插件静态表里每个模型都写了 `effortIds`，composer 据此决定要不要
   * 显示强度控件。换源时把它丢掉，等于顺手把强度选择从界面上抹了。
   */
  | {
    kind: 'ready';
    models: HarnessModelChoice[];
    selected: string | null;
    efforts: HarnessModelChoice[];
    selectedEffort: string | null;
  }
  /** harness 没装（起不来）。界面引导安装。 */
  | { kind: 'not-installed' }
  /**
   * 这个 agent 压根不说 ACP —— 没有活目录这回事，不是「没装」。
   *
   * 36 个插件里 15 个如此；其中 amp(4 条)还声明了 selectable 模型表
   * (antigravity 的 8 条静态表已随 #6335 撤掉:它改走官方 ACP 服务,目录由那个进程自报)。
   * 对它们，插件静态表是**唯一且一直以来的**来源，界面照旧用它 —— ❌ 不显示任何四态提示。
   * 把这两件事合并成 not-installed 的后果是：装着的 amp 被说成「尚未安装」，模型下拉整个消失。
   */
  | { kind: 'unsupported' }
  /** 装了但没登录。协议把该怎么登也一起回来了，界面直接用它做入口。 */
  /**
   * 这位用户此刻没登录这家 harness。
   *
   * ⚠️ 仍然**带着档位**:未登录 ≠ 这个引擎没有推理强度轴。档位是引擎的固有属性,与登录无关,
   * 而用户此刻完全可能正打算用**咕咕的**模型跑 —— 那条路根本不需要他登录。
   * 这两个字段由第二遍探测(占位凭据)填,读不出来就是空数组。
   * ❌ 不把它并进 `ready`:那会让「没登录」这条事实消失,界面就没法解释为什么没有 BYOK 模型。
   */
  | {
      kind: 'auth-required';
      authMethods: HarnessAuthMethod[];
      efforts: HarnessModelChoice[];
      selectedEffort: string | null;
      /**
       * #6264 不是「没登录过」,是「登录已失效」:凭据文件还在,可这家最近一次真用时被拒了。
       * 模型目录探针自己判不出这一格(codex 没登录也列得出目录),由界面按登录读数叠上来;界面据此说「重新登录」。
       */
      expired?: boolean;
    }
  /** 装了、登录了，但这次没读出来（超时/协议异常）。界面给原因与重试。 */
  | { kind: 'unavailable'; reason: string; reasonCode?: 'probe-failed' };

/**
 * 起一个 harness 的 ACP 进程。由组合根注入。
 *
 * ❌ 本模块不直接碰 plugin-host / settings / Electron `app`：上一版直接调
 * `resolveLocalAcpSpawnContext`，把整栈拽了进来，单测当场崩在 `app.getPath`。
 * 注入之后这个模块只做「起进程 + 说协议」，在任何 node 环境里都能测。
 */
export type AcpSpawnSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 探针那一条 `session/new` 的 `_meta`(插件的 `acp.catalogProbeSessionMeta`:不装用户 MCP)。 */
  sessionMeta?: Record<string, unknown>;
};
/** `null` = 这家插件不说 ACP（→ `unsupported`）；`'not-found'` = 没有这个插件（→ `not-installed`）。 */
export type AcpSpawnResolver = (
  pluginId: string,
  /** 这份目录替哪条腿读 —— 腿的配置根可能不同(#6246),起进程的 env 由它定。 */
  leg: SessionpageLeg,
  cwd: string,
  /** 第二遍探测:交给插件 `buildSpawn` 的占位平台载荷(codex 那族);只为把 `thought_level` 读出来。 */
  probePlatform?: AcpPlatformInjection
) => Promise<AcpSpawnSpec | null | 'not-found'>;

let resolveAcpSpawn: AcpSpawnResolver = async () => null;

export function setAcpSpawnResolver(resolver: AcpSpawnResolver): void {
  resolveAcpSpawn = resolver;
}

/** 第二遍探测要叠上去的东西(由宿主按这家的 Chat UI 注入信封生成,见 `harness-catalog-probe-env.ts`)。 */
export type ProbePlatformCredentials = {
  env: Record<string, string>;
  sessionMeta?: Record<string, unknown>;
  platform?: AcpPlatformInjection;
};

/**
 * 第二遍探测用的**占位**中转凭据 —— 由**宿主**装进来。
 *
 * ## 为什么是注入而不是直接 import
 *
 * 算这份 env 要用 `engine-injection-contract`(哪家用哪种注入方言)与 `capability-bundle`
 * (方言 → 具体环境变量),两个都住在**宿主 bundle**(`apps/desktop/electron/`)里。
 * 会话页从那边相对路径 import 会被 esbuild 再打一份进来,两份模块各有各的模块级状态 ——
 * `extension-bridge-relay` 就是这么把扩展的五个宿主动词从上线第一天起全弄坏的
 * (而单测因为 mock 掉了那条 import 全程是绿的)。
 * ⇒ 跨这条边界只走注入。
 *
 * `scratchDir` 是这一趟专用的临时目录:要落盘的文档写在这里,探完由这边整目录删掉。
 * 生成不出来就**抛**(写明哪一家、为什么);没装解析器同样抛 —— ❌ 当成「没有凭据」悄悄跳过。
 */
export type ProbePlatformEnvResolver = (pluginId: string, scratchDir: string) => Promise<ProbePlatformCredentials>;

let resolveProbePlatformEnv: ProbePlatformEnvResolver = async (pluginId) => {
  throw new Error(`model catalog probe: ${pluginId} needs placeholder credentials but the host installed no resolver`);
};

export function setProbePlatformEnvResolver(resolver: ProbePlatformEnvResolver): void {
  resolveProbePlatformEnv = resolver;
}

/**
 * 停摆上限 —— **不是**握手总预算。这两者的区别就是这一刀的全部。
 *
 * ## 之前那个 20s 总预算是一条设计性赛跑
 *
 * 它判的是「这次握手**总共**用了多久」,而握手时长 = harness 冷启时长,那是台机器性能与当下负载
 * 的函数。实测(2026-08-26 d15):`mimo --version` 光把 99MB bundle 启起来打一行版本号就 3.8s;
 * 它的 ACP 握手冷启 6.99s、热 5.39s;opencode 7.09s。而本仓自己记过 mac1 上 opencode 11.8s
 * 对 d15 3.2s —— **同一个 harness 差 3.7 倍**。于是同一台机器上同一个**健康**的 mimocode,
 * 闲时 18s 报 `ready`、忙时 22s 报 `unavailable`(界面写「读取失败」)。那不是读数,那是掷骰子。
 *
 * ## 换成「进程还有没有动静」
 *
 * 现在判的是**停摆**:进程还活着,但 stdout / stderr 一个字节都不出,持续这么久。
 * 它防的是一种具体的真实故障 —— **adapter 起来了、管道开着、但永不应答**
 * (卡在交互式 stdin 提问,或一个没有超时的网络调用上)。这种进程不会退,`processFailed` 等不到,
 * 不设上限就会永远占着 `inFlight`,那家 harness 的目录从此卡在 `unknown` 直到重启 = 静默失败。
 *
 * ⇒ 关键区别:**总时长再也不参与判决**。一台慢机器上健康的 harness,不管冷启花 5s 还是 50s,
 *   只要它在推进(哪怕只是往 stderr 打启动日志),就永远不会被判死。赛跑消失了。
 *
 * ## 这个数是怎么来的(可判假)
 *
 * 判据是「健康 harness 的**最长静默段**」,不是「健康 harness 的总时长」。实测 d15:
 * - mimo 热启:spawn 后**整整 4.58s 一个字节都没有**,然后直接答 initialize —— 全程最长静默段;
 * - mimo 冷启:3.88s 静默 → stderr 启动日志 → 1.12s → 1.99s;
 * - opencode:3.77s 静默 → 首字节 → 3.21s。
 * ⇒ d15 上健康的最长静默段 ≈ 4.6s。按本仓记录的 mac1/d15 3.7 倍推到 macOS ≈ 17s。
 * 120s 对实测值有 26 倍余量、对 macOS 推算值有 7 倍余量 —— 一个进程 120s 内**一点输出都没有**
 * 已经在任何实测健康行为之外,判它挂了是判决,不是抢跑。
 *
 * ⚠️ 余量之所以敢给这么大,是因为**现在没有人在等它**了:目录读取已挪出关键路径
 * (`lookupHarnessModelCatalog`),这个上限只决定「多久回收一个卡死的进程」,不决定用户等多久。
 * ❌ 反过来说,谁要是把它挪回关键路径,这个数就又变成用户的等待时间 —— 那时该改的是调度,
 *    不是把这个数调小(调小 = 把赛跑原样装回去)。
 *
 * ⚠️ 残留(如实记账):完全不出声的 harness 冷启若真超过 120s,停摆守卫仍会误判。上面那份实测里
 *    最长静默段是 4.58s,离 120s 有 26 倍;真出现了要重新量,❌ 不要顺手调大 —— 那说明这个
 *    形状对那家不成立,得换判据。
 */
export const INACTIVITY_LIMIT_MS = 120_000;

/** 实际生效值。测试压到毫秒级来验行为,传 `null` 还原。❌ 生产不改它。 */
let inactivityLimitMs: number = INACTIVITY_LIMIT_MS;
export function __setInactivityLimitForTest(ms: number | null): void {
  inactivityLimitMs = ms ?? INACTIVITY_LIMIT_MS;
}

/**
 * 盯着「还有没有动静」。任何一个字节(stdout 或 stderr)都算推进,把计时重新拉满。
 *
 * ❌ 不用 `setInterval` 轮询:那会把检测精度和轮询周期绑在一起,测试里要嘛不准要嘛得等一整个周期。
 * 每次推进重新 arm 一个 `setTimeout` 是精确的。`unref` 掉,免得它把 node 进程吊在那儿。
 */
function watchForInactivity(
  child: ChildProcessWithoutNullStreams,
  pluginId: string
): { stalled: Promise<never>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  let fire!: (error: Error) => void;
  const stalled = new Promise<never>((_, reject) => {
    fire = reject;
  });
  // 输了 race 的那一边没人接 = 一条 unhandled rejection。空 catch 收掉(结果已不重要)。
  stalled.catch(() => {});

  const arm = (): void => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      done = true;
      fire(new Error(
        `${pluginId}: ACP 探测停摆 —— 进程仍活着,但已连续 ${inactivityLimitMs}ms 没有任何输出`
      ));
    }, inactivityLimitMs);
    timer.unref?.();
  };
  const bump = (): void => arm();

  child.stdout.on('data', bump);
  child.stderr.on('data', bump);
  arm();

  return {
    stalled,
    stop: () => {
      done = true;
      if (timer) clearTimeout(timer);
      child.stdout.off('data', bump);
      child.stderr.off('data', bump);
    },
  };
}

/**
 * 探到的清单能用多久。
 *
 * ⚠️ 这里是本功能最容易自伤的地方：**咕咕要修的那个缺陷，本质就是「缓存过期没人刷」** ——
 * codex 自己的 `~/.codex/models_cache.json` 停在 client 0.144.6，而 CLI 已经 0.146.0，于是它
 * 报出一个 codex 自己都不认识的 `gpt-5.6`。照抄那个形状等于把同一个坑挖进咕咕。
 *
 * 所以作废有两把闸，**版本是主闸、时间是兜底**：
 * - harness 版本一变就作废。模型清单跟着 CLI 版本走，这是最实在的触发器（上面那个案例就是它）。
 * - 版本没变也有 TTL：清单可以在服务端变而 CLI 不动（claude 的 `default` 指向、codex 的
 *   服务端清单都是这样），所以时间上也得有个尽头。
 */
export const READY_TTL_MS = 12 * 60 * 60_000;

/**
 * 失败态只缓存很短一会儿。
 *
 * `not-installed` / `auth-required` 恰恰是用户**正在动手解决**的状态：他去装了、去登录了，
 * 回来一看还说「尚未安装」，那这个缓存就是在骗人。这里只够把连点几下的重复探测合并掉，
 * ❌ 不是真正意义上的缓存。
 */
export const FAILURE_TTL_MS = 30_000;

interface CachedCatalog {
  state: HarnessCatalogState;
  /**
   * 探这一份时**全部输入**的指纹：起哪个进程、带哪些参数、带哪份 env（其中就有
   * `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` 这类「到底跑哪一份拷贝」）、那条路径此刻指着的那份文件
   * （就地升级只换文件不换路径，#7081）、以及 harness 版本。
   *
   * ⚠️ 这一格从前是 `harnessVersion`，即拿版本号**代理**被探对象的身份 —— 而版本号是这份身份的
   * 有损投影：双账号（`claude2` 这类 `CLAUDE_CONFIG_DIR` wrapper）与裸 `claude` 指向同一个二进制、
   * 版本号逐字相同，换的只是登录身份，于是缓存键撞了。键一丢信息，正确性就只能靠**外部记得来通知**
   * （谁改了配置谁去 clear），而那张「谁通知谁」的表是「写者 × 缓存」那么大、靠注释维护的，
   * 那张表上已经有三份缓存、其中两份是漏掉之后补上去的，模型目录是第四份（#5605）。
   * 指纹让失效变成**派生**：输入变了自然查不中，没有人需要记得。
   *
   * `null` = 当时算不出（解析不出可执行文件 / 这家不说 ACP），那就只能靠 TTL——与旧版
   * 「两边都不知道版本」同一语义。字段**缺失**（盘上的旧结构行）则一律判不新鲜，重探一次。
   */
  inputsHash: string | null;
  probedAt: number;
}

/**
 * 「这一趟会跑哪一份东西」的身份材料 —— 由组合根注入，返回一段可比较的字符串。
 *
 * ## 为什么**不**复用 `AcpSpawnResolver`
 *
 * 算身份**不意味着起进程**。第一版就是拿 `resolveAcpSpawn` 顺手算的，结果 8 条用例当场变红：
 * 那批用例正是靠「解析器被调了几次」来判「第二趟探测跑没跑」「lookup 有没有等 harness」的，
 * 而它们判的是**起了几个进程**。把两件事挂在同一个出口上，就是把「我要知道跑哪一份」和
 * 「我要跑一份」混成一个动词 —— 用例替我把这个混淆抓了出来，这里按它分开。
 *
 * 拿不到（没装 / 运行时不兼容 / 这家不说 ACP）返回 `null`：身份未知就退回 TTL，
 * ❌ 不因为身份算不出来就把目录判成坏的。
 */
export type SpawnIdentityResolver = (pluginId: string, leg: SessionpageLeg) => Promise<string | null>;

let resolveSpawnIdentity: SpawnIdentityResolver = async () => null;

export function setSpawnIdentityResolver(resolver: SpawnIdentityResolver): void {
  resolveSpawnIdentity = resolver;
}

/**
 * 一份目录缓存在哪个键下 —— 由组合根按**插件声明**决定(#6246)。
 *
 * 两条腿读同一个配置根的家(绝大多数)两条腿共用一份:再按腿分只会让每家多冷启一次 harness,
 * 换来两份逐字节相同的清单。声明了按腿不同的配置根的家(pi 的 `acpConfigRoot`)才按腿分开 ——
 * 那两份清单真的不同:终端腿读用户自己的 `~/.pi/agent`,ACP 腿读咕咕自有的根。
 * 不注入时每家一份(按插件)。
 */
export type CatalogKeyResolver = (pluginId: string, leg: SessionpageLeg) => string;

let resolveCatalogKey: CatalogKeyResolver = (pluginId) => pluginId;

export function setCatalogKeyResolver(resolver: CatalogKeyResolver): void {
  resolveCatalogKey = resolver;
}

/**
 * 这一趟探测的输入指纹 = 身份材料 + harness 版本。
 *
 * 严格地**推广**了旧的版本闸：从前是 `hash(版本)`，现在是 `hash(身份, 版本)`。
 * 身份算不出来时退化成前者，逐字保持旧行为（包括「缓存带版本、此刻还不知道版本 ⇒ 作废」那条自愈）。
 */
async function resolveInputsHash(
  pluginId: string,
  leg: SessionpageLeg,
  harnessVersion: string | null
): Promise<string | null> {
  const identity = await resolveSpawnIdentity(pluginId, leg).catch(() => null);
  // 两样都不知道 ⇒ 没有任何可比的身份，只能靠 TTL。
  if (identity === null && harnessVersion === null) return null;
  // 摘要而不是原文：身份材料里带着 env（含 API key），而指纹只需要回答「变没变」。
  return createHash('sha256')
    .update(JSON.stringify({ identity, harnessVersion }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 落盘的只有 `ready`。
 *
 * `FAILURE_TTL_MS` 的抬头自己写着它「只够把连点几下的重复探测合并掉，**不是真正意义上的缓存**」——
 * 既然如此它就该只活在内存里（而并发去重本来就由 `inFlight` 负责）。把一条 `auth-required`
 * 写进 appSettings，等于让「用户当时还没登录」这个瞬时事实跨重启存活：#5605 里那句
 * `auth-required` 在盘上躺了 17 分钟，正是把去重写成缓存的直接后果。
 *
 * ⇒ 内存镜像保留全部（本次运行内照常去重），盘上只留成功的读数。
 */
function persistableEntries(all: Record<string, CachedCatalog>): Record<string, CachedCatalog> {
  return Object.fromEntries(Object.entries(all).filter(([, e]) => e.state.kind === 'ready'));
}

/**
 * 缓存的落盘位置，由组合根注入（生产接 appSettings 表）。
 *
 * ❌ 模块不直接 import db：那会把 Electron `app` / drizzle 一起拽进来，单测又得崩在
 * `app.getPath`。不注入时退化成纯内存缓存 —— 仍然省掉同一次运行里的重复探测。
 */
export interface CatalogStore {
  read(): Promise<Record<string, CachedCatalog>>;
  write(all: Record<string, CachedCatalog>): Promise<void>;
}

let store: CatalogStore | null = null;
export function setCatalogStore(next: CatalogStore | null): void {
  store = next;
  memory = null;
}

/** 落盘内容的内存镜像；没有注入 store 时它就是全部。 */
let memory: Record<string, CachedCatalog> | null = null;
/** 同一家 harness 正在探时，后来的调用等同一个 promise，❌ 不并发起两个进程。 */
const inFlight = new Map<string, Promise<HarnessCatalogState>>();

async function loadAll(): Promise<Record<string, CachedCatalog>> {
  if (memory) return memory;
  memory = store ? await store.read().catch(() => ({})) : {};
  return memory;
}

function isFresh(entry: CachedCatalog, inputsHash: string | null): boolean {
  const age = Date.now() - entry.probedAt;
  // 盘上的旧结构行（只记过版本号、没有指纹）：判不新鲜，重探一次把身份补齐。
  // ❌ 不按「两边都不知道」处理 —— 那会让升级前那份读数靠 TTL 再活 12 小时。
  if (entry.inputsHash === undefined) return false;
  // 主闸：输入变了就作废。两边都算得出时才比 —— 算不出就别假装比过了。
  // 缓存带指纹而此刻算不出（冷启尚未解析出可执行文件）时也必须作废：沿用旧目录会跳过后台探测，
  // 而 `staleTime: Infinity` 会把它冻结到 TTL。两边都为 null 才只能靠 TTL。
  // 这个冷启窗是有意的 per-harness 自愈：不等待全量依赖探测，直接触发该家的 ACP 探测，
  // 由 `refreshing` 轮询收敛到新目录或可见失败态。
  if (entry.inputsHash !== null && inputsHash === null) return false;
  if (entry.inputsHash !== null && inputsHash !== null
    && entry.inputsHash !== inputsHash) return false;
  return age < (entry.state.kind === 'ready' ? READY_TTL_MS : FAILURE_TTL_MS);
}

/**
 * 拿这家 harness 的模型目录：缓存新鲜就直接给，否则探一次并落盘。
 *
 * 新鲜与否比的是**这一趟的输入指纹**（见 `CachedCatalog.inputsHash`）：换了一份拷贝、换了配置根、
 * 换了注入的 env，都会自然查不中并重探 —— ❌ 不需要任何人在改配置时记得来清这份缓存。
 * `harnessVersion` 仍由调用方给（agent payload 里本来就有），它作为指纹的一维参与计算。
 * ⚠️ 它认不出**本次运行中**的就地升级：版本只在启动时探一次(#7081)。路径不变、文件换了的那一类
 * 靠身份里那份文件的 stamp 识别(见 `resolveHarnessSpawnIdentity`)。
 * `force` 供界面上的「刷新」用 —— 用户刚装完 / 刚登录完，不该让他等 TTL。
 */
async function ensureCatalog(
  key: string,
  pluginId: string,
  leg: SessionpageLeg,
  inputsHash: string | null
): Promise<HarnessCatalogState> {
  const running = inFlight.get(key);
  if (running) return running;

  const task = (async () => {
    // @@@catalog-probe-no-spin:抛出也要缓存终态,否则 lookup 永远返回 unknown 并反复探测。
    // 原因码由界面按当前语言呈现,异常细节只进日志。
    let state: HarnessCatalogState;
    try {
      state = await probeHarnessModelCatalog(pluginId, leg);
    } catch (error) {
      log.error({ error }, `${pluginId}: 模型目录探测抛出 → 落为 unavailable(界面给原因与重试)`);
      state = {
        kind: 'unavailable',
        reason: 'Model catalog probe failed',
        reasonCode: 'probe-failed',
      };
    }
    const next = { ...(await loadAll()), [key]: { state, inputsHash, probedAt: Date.now() } };
    memory = next;
    // 落盘失败不该让这次探测作废 —— 内存里已经有结果，界面照常用。
    await store?.write(persistableEntries(next)).catch((error: unknown) => {
      log.warn({ error }, `${pluginId}: 模型目录缓存落盘失败（本次结果仍可用）`);
    });
    return state;
  })().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

export async function getHarnessModelCatalog(
  pluginId: string,
  options: { leg: SessionpageLeg; harnessVersion?: string | null; force?: boolean }
): Promise<HarnessCatalogState> {
  const key = resolveCatalogKey(pluginId, options.leg);
  const all = await loadAll();
  const cached = all[key];
  const inputsHash = await resolveInputsHash(pluginId, options.leg, options.harnessVersion ?? null);
  if (!options.force && cached && isFresh(cached, inputsHash)) return cached.state;
  return ensureCatalog(key, pluginId, options.leg, inputsHash);
}

/**
 * 此刻能给出的最好答案 —— **绝不等 harness 进程**。这是目录读取离开关键路径的那一刀。
 *
 * ## 为什么必须有这个入口
 *
 * `getHarnessModelCatalog` 缓存不新鲜时会 `await` 一整趟 ACP 握手 = 一次 harness 冷启。
 * 实测(2026-08-26 d15)那是 5.4–7.0s,owner 在 macOS 上实测 mimocode **30s** —— 那 30s 全程
 * 压在 `agents.modelCatalog` 这条 RPC 上,composer 就干等着。
 *
 * 这里把两件事拆开:
 *  · **答**:手上有什么就给什么(新鲜的给新鲜的,只有陈的就给陈的,什么都没有才 `unknown`);
 *  · **探**:该探就在后台探,调用方不等。
 *
 * ## `refreshing` 不是装饰,是契约
 *
 * 它告诉调用方「你手上这份还会变,盯着点」。渲染层据此轮询(见 use-harness-model-catalog.ts);
 * 少了它,`staleTime: Infinity` 的查询会把一份**陈的**清单一直显示到用户重启 app ——
 * 那是把「等 30 秒」换成「一直是错的」,更糟。
 *
 * ## ❌ 不投机预热
 *
 * 触发时机就是「用户问到了这家」,不多也不少。「开机把装了的都预热一遍」被否掉是有实测依据的:
 * 每一家都是一次冷启(mimo 单是 `--version` 就 3.8s),而 macOS 上新可执行文件的首次 execve
 * 要过安全检查且**全机串行** —— 那会把开机拖垮,换来的还多半是用户今天根本不会选的那几家。
 * 「他下一个会切到哪家」没有确定答案,❌ 不猜。
 *
 * ## fail loud
 *
 * 后台那趟的异常不吞:`probeHarnessModelCatalog` 内部已经把失败翻译成 `unavailable` 状态并
 * **写进缓存**(于是下一次轮询就把「读取失败」交到界面上,❌ 不会悄悄继续显示旧清单);
 * 真漏到这一层的只可能是缓存读写自身的异常,那种照原样 `log.error` 报出来。
 */
export interface HarnessCatalogLookup {
  /** 此刻手上最好的那份。可能是陈的 —— `refreshing` 会说。 */
  state: HarnessCatalogState;
  /** 后台正在探(这次调用启动的,或已经在跑的那趟)。 */
  refreshing: boolean;
}

export async function lookupHarnessModelCatalog(
  pluginId: string,
  options: { leg: SessionpageLeg; harnessVersion?: string | null; force?: boolean }
): Promise<HarnessCatalogLookup> {
  const key = resolveCatalogKey(pluginId, options.leg);
  const all = await loadAll();
  const cached = all[key];

  // 已经有一趟在跑 ⇒ 这次的答案必然是「陈的 + refreshing」,与指纹无关,先答掉。
  // ❌ 别在这条路上算指纹:渲染层在 refreshing 期间每 700ms 问一次,而算指纹要解析可执行文件
  //(一次 `which`)—— 那会把一条只为说「还在探」的轮询变成每 700ms 一个子进程。
  if (!options.force && inFlight.has(key)) {
    return { state: cached?.state ?? { kind: 'unknown' }, refreshing: true };
  }

  const inputsHash = await resolveInputsHash(pluginId, options.leg, options.harnessVersion ?? null);
  if (!options.force && cached && isFresh(cached, inputsHash)) {
    return { state: cached.state, refreshing: false };
  }

  // 起(或搭上)后台那一趟 —— ❌ 不 await。`inFlight` 保证同一家同时只有一个进程。
  void ensureCatalog(key, pluginId, options.leg, inputsHash).catch((error: unknown) => {
    log.error({ error }, `${pluginId}: 后台模型目录探测异常退出`);
  });

  // 有陈的就先给陈的:界面留着上一份清单可用,好过闪回「正在读取」。
  return { state: cached?.state ?? { kind: 'unknown' }, refreshing: true };
}

/** 测试用：清空内存镜像与在途探测。 */
export function __resetHarnessModelCatalogCache(): void {
  memory = null;
  inFlight.clear();
}

/**
 * 测试用:等所有在途探测收摊。
 *
 * ⚠️ 有了后台探测之后这条是**必须**的,不是讲究:杀进程组发生在 `probeOnce` 的 `finally` 里,
 * 而后台那趟活得比用例长 —— vitest worker 一退,`finally` 根本不会跑,子进程就留成孤儿
 * (实测:跑完一轮 d15 上躺着 4 个 `gugu-fake-acp-…` 假 agent 进程)。CI 机器上这种泄漏会越积越多。
 * ❌ 不能用 `__resetHarnessModelCatalogCache()` 代替:清空 map 只是撒手,不等它们收摊。
 */
export async function __drainProbesForTest(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

/**
 * 一项 `select` 型 configOption → 选项列表。模型与档位是同一种形状，写两遍就会漂。
 * 协议只给 value/name/description，这里也只取这三样 —— 没有的不编。
 */
function toChoices(option: RawConfigOption | undefined): HarnessModelChoice[] {
  const out: HarnessModelChoice[] = [];
  for (const raw of option?.options ?? []) {
    if (typeof raw?.value !== 'string' || !raw.value) continue;
    out.push({
      id: raw.value,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.value,
      ...(typeof raw.description === 'string' && raw.description
        ? { description: raw.description }
        : {}),
    });
  }
  return out;
}

interface RawConfigOption {
  id?: string;
  configId?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: { value?: unknown; name?: unknown; description?: unknown }[];
}

function toAvailableModels(raw: unknown[] | undefined): HarnessModelChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((model) => {
    if (!model || typeof model !== 'object') return [];
    const entry = model as { modelId?: unknown; id?: unknown; name?: unknown; description?: unknown };
    const id = typeof entry.modelId === 'string' ? entry.modelId : typeof entry.id === 'string' ? entry.id : '';
    if (!id) return [];
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}),
    }];
  });
}

/**
 * 探一家 harness：起 ACP 进程 → initialize → session/new → 读模型清单 → 收摊。
 *
 * 不发任何 prompt，因此不耗额度；实测三家都没有留下会话记录。
 */
/**
 * 后台探针**永远不许弹浏览器** —— 对所有 harness 一视同仁。
 *
 * 真出过事:owner 什么都没点,屏幕上冒出一页 Google 登录(#6335 的探针那一轮)。成因是这类 harness 在
 * `session/new` 里发现「配了 OAuth 但没凭据」时会**自己**拉起浏览器登录(antigravity 的
 * `agy_acp_server` stderr 原文「Credentials missing or invalid. Launching browser login flow...」)。
 * 探针是咕咕在后台读模型目录,用户没有发起任何登录 —— 那一页是凭空冒出来的。
 *
 * 做法:把 `BROWSER` 指向一个什么都不做的程序。Python 的 `webbrowser` 优先认 `$BROWSER`
 * (实测 agy_acp_server 1.1.1:`BROWSER=<记账脚本>` 时登录链接被记进脚本、没有任何窗口弹出),
 * Node 系 `open` 包在 Linux 上走 xdg-open 也认它。posix 上用 `true`(PATH 上恒在、退出码 0)。
 *
 * ⚠️ 只管这一条后台路。用户亲手点的登录(`startLogin` 的协议登录)**不带**它 —— 那一次浏览器就该弹。
 * Windows:指 `%SystemRoot%\System32\attrib.exe`。Python `webbrowser` 把 `$BROWSER` 整串当**一个**可执行
 *    文件、URL 作唯一参数(`Popen([name, url])`),**返回非 0 就接着试下一个 —— 最后落到 `windows-default`
 *    照样弹浏览器**,所以这里必须是「带任意一个参数都退出 0、没有副作用、不经 shell 解析」的真 `.exe`。
 *    2026-09-24 win-dev(Windows Server 2025,Python 3.12)实测:`attrib.exe <url>` 只读查询、退出 0,
 *    `webbrowser.open` 返回 True,`windows-default` 没被轮到。
 *    ❌ 别换成 `.cmd` / `.bat`:同一次实测里 URL 的 `&` 被 cmd 当成命令分隔符,后半截被当命令执行了。
 * ⚠️ 这只挡得住「经 $BROWSER 开浏览器」的实现;直接调 macOS `open` / LaunchServices 的 harness 挡不住。
 *    ❌ 不因此去改 PATH 屏蔽 `open`:那会连 harness 正常要用的子命令一起打断。
 */
export function suppressBrowserLaunch(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows';
    return { ...env, BROWSER: win32.join(systemRoot, 'System32', 'attrib.exe') };
  }
  return { ...env, BROWSER: 'true' };
}

async function stopProbeProcess(probe: OwnedChild): Promise<void> {
  try {
    signalEngineTree(probe, 'SIGKILL', defaultEngineTreeOps());
    await probe.stop();
  } catch (error) {
    // 清理工具的 ENOENT 不代表 harness 没安装。
    throw new Error(`ACP model probe cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function probeOnce(
  pluginId: string,
  leg: SessionpageLeg,
  /**
   * `null` = 第一遍(照用户自己的真实环境)。非 null = 第二遍要叠上去的那份占位凭据。
   *
   * 三格各有去处:`env` 叠进适配器进程环境,`sessionMeta` 并进 `session/new` 的 `_meta`,
   * `platform` 交给插件的 `buildSpawn` —— 与真会话 Chat UI 注入的三种信封一一对应。
   */
  probeCredentials: ProbePlatformCredentials | null
): Promise<HarnessCatalogState> {
  // 取真实路径:macOS 的 tmpdir 在 /var → /private/var 这条符号链接后面。插件按 cwd 给的「按次信任」
  // (codex 的 `-c projects."<cwd>"…`)必须和 harness 自己看到的目录逐字相同,否则它当成没标过,
  // 又把信任写回用户的配置文件(#6264)。
  const cwd = await realpath(await mkdtemp(join(tmpdir(), `gugu-model-probe-${pluginId}-`)));
  let probe: OwnedChild<ChildProcessWithoutNullStreams> | null = null;
  try {
    try {
      const spec = await resolveAcpSpawn(pluginId, leg, cwd, probeCredentials?.platform);
      if (spec === 'not-found') return { kind: 'not-installed' };
      if (!spec) return { kind: 'unsupported' };

      // ⚠️ 叠放顺序与真会话逐字一致(plugin-host 的 buildAcpSpawn 把 `capabilitySpawnEnv` 放最后)。
      // ⚠️ 只有第二遍加 —— 第一遍必须照用户自己的真实环境读,否则占位凭据会盖掉**已登录用户**
      //    那份真凭据,把一份本来读得好好的目录弄坏,还会把模型钉成一个不存在的 id。
      const env = suppressBrowserLaunch(
        probeCredentials ? { ...spec.env, ...probeCredentials.env } : spec.env
      );

      probe = spawnOwnedChild(spec.command, spec.args, {
        cwd,
        // ❌ 不铺 `...process.env`：真会话拿到的是 `buildAgentEnv` 的白名单（EDITOR/LANG/TZ +
        // agentShellEnvPassThrough），不是整份进程环境。铺了就等于探针在一个会话根本不会有的环境里读模型 ——
        // 那读到的还是「某个环境下的表」，正是这个 PR 要消灭的东西。解析器给什么就是什么。
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 真 harness 二进制是 adapter 的**孙**进程。不开进程组，超时后 kill 只杀得掉 adapter，
        // 孙进程留成孤儿；失败态 30s 重探一次，孤儿会一直累积。
        detached: true,
        // 终身出口;首个错误另由下面的 processFailed 变成这次探测的结论,收树失败由 finally 的 stop() 报出。
        onError: (error) => log.warn({ error }, `${pluginId}: 模型目录探针进程错误`),
      }) as OwnedChild<ChildProcessWithoutNullStreams>;
      const child = probe.child;

      // 管道错误走的是 EventEmitter 的抛出路径，`processFailed` 那两个监听（promise 路径）拦不住：
      // adapter 握手前就退时（缺依赖 / 版本不对），往已关闭的 stdin 写 = EPIPE = **崩主进程**。
      // 排空 + 吞掉即可：进程真死了自有 'exit' 去 reject，这里只负责不让它掀桌子。
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      // ⚠️ spawn 的失败是**异步事件**，不是抛出：命令不存在时 `spawn()` 正常返回，随后才 emit
      // 'error'。不监听它，「没装」就会一路挂到握手超时 —— 用户等满 20s，然后被告知「坏了」而不是
      // 「去装一个」。同理 'exit'：adapter 起来就死（缺依赖、版本不对）时，握手请求永远等不到回包。
      // 这两条都由测试钉着。
      const processFailed = new Promise<never>((_, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(Object.assign(new Error(`spawn ${spec.command}: ${error.message}`), {
            code: error.code,
          }));
        });
        child.once('exit', (code, signal) => {
          reject(new Error(`ACP adapter 在握手完成前退出 (code=${code} signal=${signal})`));
        });
      });
      // 输了那一边会在 finally 的 SIGKILL 后带着 'exit' 迟到地 reject。race 已经结束，没人接它 =
      // 一条 unhandled rejection。挂个空 catch 把它收掉（结果已经不重要了）。
      processFailed.catch(() => {});

      const rpc = new AcpProbeClient(child, pluginId);
      // 三条**真实**终止条件,一条墙钟都不参与判「快慢」:
      //  · adapter 答了 → 有读数;
      //  · adapter 退了 → `processFailed`(进程自己给的事实);
      //  · adapter 活着但彻底不出声 → 停摆(见 `INACTIVITY_LIMIT_MS` 抬头)。
      const watchdog = watchForInactivity(child, pluginId);
      try {
        const sessionMeta = mergeTrustedSessionMeta(spec.sessionMeta, probeCredentials?.sessionMeta);
        const state = await Promise.race([rpc.readCatalog(cwd, sessionMeta), processFailed, watchdog.stalled]);
        log.info(`${pluginId}: 模型目录 ${describe(state)}`);
        return state;
      } finally {
        watchdog.stop();
      }
    } finally {
      if (probe) await stopProbeProcess(probe);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 「没装」按 **errno 判**，不按错误文案匹配：ENOENT 是操作系统给的事实，而文案里出现
    // "not found" 可能来自任何一层（adapter 自己的报错、上游 API 的 404）。判错方向的代价是
    // 界面把「坏了」说成「去装一个」，用户照做也修不好。
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const state: HarnessCatalogState = code === 'ENOENT'
      ? { kind: 'not-installed' }
      : { kind: 'unavailable', reason: message };
    // ⚠️ 把**协议错误码**单独带出来:logger 序列化 Error 只留 name/message/stack,
    //    而码住在 AcpRpcError 私有的 payload 里 —— 2026-08-26 查 kimi 为什么被判成
    //    「读取失败」时,日志里一个码都看不到,只能靠猜。判错分类的下一步永远是「它到底回了几」。
    const rpcCode = error instanceof AcpRpcError ? error.code() : undefined;
    log.warn({ error, rpcCode }, `${pluginId}: 模型目录探测失败 → ${state.kind}`);
    return state;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {
      // 临时目录清不掉不该让探测失败。
    });
  }
}

/**
 * 探一家 harness 的模型目录 —— **最多两趟**。
 *
 * 第一趟照用户自己的环境读。读到 `ready` 就完了(已登录的用户走的就是这条,与改动前逐字节一致)。
 *
 * 第一趟判成 `auth-required` 就跑第二趟:用**占位**中转凭据把进程起起来,单为把
 * `category="thought_level"` 那份档位读出来。
 *
 * ## 为什么值得多这一趟
 *
 * 模型清单与推理档位来自同一份 `session/new` 响应。没登录时整份响应都拿不到,于是推理强度那一行
 * **整个不画** —— 而 owner 2026-08-26 定的线是:每家 harness 模型和推理强度都得有,没有本身就是 bug。
 * 用户此刻很可能正打算用**咕咕的**模型跑,那条路根本不需要他登录这家 harness,
 * 却因为这次读不到而失去了调深浅的能力。
 *
 * ## 第二趟只取档位,❌ 不取模型清单
 *
 * 占位凭据钉的是一个不存在的模型 id,由它得出的「模型清单」是**仪器造出来的**,不是读数。
 * 档位不同:`thought_level` 是引擎的固有属性,与哪个模型、有没有登录都无关。
 * ⇒ 只把 efforts 挂回 `auth-required`,`kind` 保持不变 —— 「没登录」这条事实必须留着,
 *   否则界面没法解释为什么没有 BYOK 模型可选。
 *
 * 第二趟**跑了**却没读到(照旧 auth-required / 起不来 / 超时):记一条 warn、退回第一趟的结论,
 * ❌ 不因为补探没读到把整个目录判成坏的。**生成**不出占位凭据则是另一回事:那是宿主自己的缺口,抛。
 */
export async function probeHarnessModelCatalog(
  pluginId: string,
  leg: SessionpageLeg
): Promise<HarnessCatalogState> {
  const first = await probeOnce(pluginId, leg, null);
  if (first.kind !== 'auth-required') return first;

  // 占位凭据按这家真会话的 Chat UI 注入信封生成;需要落盘的文档只写进这一趟的临时目录,探完整目录删掉。
  // 生成不出来就抛,写明哪一家、为什么 —— ❌ 当成「没有凭据」跳过,那正是这一趟从来没跑过的原因
  // (这一趟曾因「悄悄退回」从接上那天起静默失效过很久)。⚠️ 这条**不能**改成「退回第一趟」:
  // 那就是把那次静默失效原样做回来。抛出去之后由 `ensureCatalog` 落成 `unavailable`,界面给原因与重试 ——
  // 响亮的落点是那里,不是让用户盯着一个转不完的圈。
  const scratchDir = await mkdtemp(join(tmpdir(), `gugu-probe-creds-${pluginId}-`));
  try {
    const probeCredentials = await resolveProbePlatformEnv(pluginId, scratchDir);
    try {
      const second = await probeOnce(pluginId, leg, probeCredentials);
      if (second.kind === 'ready' && second.efforts.length > 0) {
        log.info(`${pluginId}: 未登录,但占位凭据那趟读到 ${second.efforts.length} 档推理强度`);
        return { ...first, efforts: second.efforts, selectedEffort: second.selectedEffort };
      }
      log.warn(`${pluginId}: 占位凭据那趟没读到推理强度(${describe(second)}),退回未登录结论`);
    } catch (error) {
      log.warn({ error }, `${pluginId}: 补探档位失败,退回未登录结论`);
    }
    return first;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function describe(state: HarnessCatalogState): string {
  switch (state.kind) {
    case 'ready':
      return `${state.models.length} 条（当前 ${state.selected ?? '—'}）`;
    case 'auth-required':
      return `需要登录（${state.authMethods.map((m) => m.id).join('/') || '未提供方式'}）`;
    default:
      return state.kind;
  }
}

/**
 * 只够用来问一次模型清单的 ACP 客户端。
 *
 * ❌ 不复用 session-runtime 那套连接池：那是给有生命周期的会话用的（客户端回调、权限往返、
 * 复用与保活）。探针没有会话，借它的生命周期语义只会把两件事绑死。
 */
class AcpProbeClient {
  private buffer = '';
  private nextId = 1;
  private authStatusKind: string | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly pluginId: string,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    // stderr 只排空:adapter 的日志不该把管道堵死,也不该混进协议流。
    child.stderr.resume();
  }

  private onData(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非协议行（adapter 偶尔往 stdout 打日志）
      }
      const id = msg.id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        if (msg.error) waiter?.reject(new AcpRpcError(msg.error));
        else waiter?.resolve(msg.result);
      } else if (msg.method === '_auth/status_update') {
        const kind = (msg.params as { authStatus?: { kind?: unknown } } | undefined)
          ?.authStatus?.kind;
        if (typeof kind === 'string') this.authStatusKind = kind;
      } else if (typeof msg.method === 'string' && id !== undefined) {
        // adapter 反过来问我们（权限、读写文件）。探针一律拒：它不该产生任何副作用。
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'probe: unsupported' } });
      }
    }
  }

  private send(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async readCatalog(cwd: string, sessionMeta?: Record<string, unknown>): Promise<HarnessCatalogState> {
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      // 探针一律拒绝反向请求（它不该产生任何副作用），所以这里就得**如实声明 false** ——
      // 声明 true 再 -32601 拒掉，等于骗 adapter 去发一个注定失败的请求：它可能报错，
      // 也可能重试到我们 20s 超时，最后用户等满超时被告知「坏了」。
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        /**
         * 「咕咕能替用户跑一个交互式登录终端」—— 这是**关于咕咕的事实**(`AgentSignInModal`
         * 就是那个终端),不是关于这个探针进程的,所以如实声明 true。
         *
         * ⚠️ 它与上面 `fs` 那两个 false **不同类**,别照着抄成 false:`fs` 的 true 意味着
         *    探针得在**带内**接住 agent 反向发来的读写请求(它一律拒,所以必须报 false);
         *    `auth.terminal` 从不产生任何带内请求 —— 它只决定 agent **advertise 什么**。
         *
         * ⚠️ 少了这一行的后果不是「少一点信息」,而是**看不见**:规范原文
         *    「An Agent may advertise a `terminal` method only when this capability is present」。
         *    2026-08-27 在 d15 上对同一个 adapter 做的差分实测(唯一变量就是这一行):
         *      不声明 → `authMethods: []`
         *      声明   → 两条 `type:"terminal"`,带着 `args:['--cli','auth','login','--claudeai']`
         *               与 `['--cli','auth','login','--console']`
         *    也就是说,「claude 没有登录方式」这个读数一直是我们自己造出来的。
         */
        auth: { terminal: true },
        /**
         * ⚠️ 这一行**不是**上面 `auth.terminal` 的重复,删掉任何一个都会让一批 harness 变哑。
         *
         * 同一件事,线上有**两套互不相认的门控**:
         *  · 规范的 `clientCapabilities.auth.terminal` —— 新一代 adapter 认它
         *    (咕咕钉的 `@agentclientprotocol/*` 就是这一代);
         *  · Zed 的厂商扩展 `clientCapabilities._meta['terminal-auth']` —— 老一代认它
         *    (opencode / mimocode / 老 `@zed-industries/claude-code-acp` 走这条)。
         *
         * 一手出处(读的是真源码,不是文档转述):`sst/opencode@c2eacd7`
         * `packages/opencode/src/acp/service.ts:102-111`,逐字
         * `if (params.clientCapabilities?._meta?.["terminal-auth"] === true)` 才把
         * `_meta['terminal-auth'] = { command, args, label }` 挂上去。mimocode 是 opencode 的
         * 逐字节 fork,同一道门。
         *
         * 阴性对照(2026-08-27 真起进程):只发 `auth:{terminal:true}` 不发这一行,opencode 与
         * claude-code-acp **双双把 `_meta` 从方法里去掉**,只回裸的 `{description,name,id}` ——
         * 也就是说少了这行,拿到的仍然只是一个名字。
         */
        _meta: { 'terminal-auth': true },
      },
      clientInfo: { name: 'gugu', version: '0' },
    });
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });

    // `initialize` 的响应里就带着登录方式(ACP `InitializeResponse.authMethods`)。
    // 收着它:有的 harness 在 `session/new` 的错误里**不**重复一份(kimi 就是),
    // 那时这份就是「去哪登」的唯一来源。
    const initAuthMethods = toAuthMethods(
      (initialized as { authMethods?: unknown } | null)?.authMethods
    );

    let created: unknown;
    try {
      created = await this.request('session/new', { cwd, mcpServers: [], ...(sessionMeta ? { _meta: sessionMeta } : {}) });
    } catch (error) {
      // 未登录不是「坏了」：协议把该怎么登一并回来了（实测 qwen 就走这条），
      // 界面据此给登录入口，而不是一个点不动的空下拉。
      //
      // 两条判据,都是**结构化字段**,❌ 都不是文案匹配:
      //  · 错误里带 `data.authMethods`(qwen);
      //  · 错误码是 ACP 规定的 `-32000`(kimi)。这个码是协议自己的常量 ——
      //    实测 kimi 0.38.0 打包进去的那份 ACP 库原文:
      //    `static authRequired(data, msg) { return new RequestError(-32e3, 'Authentication required…', data) }`
      //    与 `internalError` 的 -32603、`requestCancelled` 的 -32800 并列,是一张固定的码表。
      //
      // ⚠️ 少了第二条的后果(2026-08-26 MBP 实测):kimi 被判成 `unavailable`,界面说
      //    「读取 Kimi 的模型失败」—— 用户被告知「坏了」,而真相是「去登录就行」;
      //    并且 `auth-required` 专属的第二遍探测不会跑,推理强度那一行跟着一起消失。
      const methods = error instanceof AcpRpcError ? error.authMethods() : null;
      const authByCode = error instanceof AcpRpcError && error.isAuthRequiredCode();
      // 档位这两格由**第二遍**探测填(见 probeHarnessModelCatalog);第一遍读不到就是空。
      if (methods || authByCode) {
        return {
          kind: 'auth-required',
          // 错误里那份优先(它更贴近这一次拒绝的原因),没有就用 initialize 时收下的。
          authMethods: methods ?? initAuthMethods,
          efforts: [],
          selectedEffort: null,
        };
      }
      throw error;
    }

    // Claude publishes its account identity on the connection/session boundary. Let pending
    // stdout parsing finish before trusting a model catalog: `none` means the native source is
    // unavailable even when session/new itself was able to initialize. A MessageChannel turn
    // observes a late notification without depending on wall-clock timers or fake-timer state.
    if (this.pluginId === 'claude') await yieldEventLoop();
    if (this.pluginId === 'claude' && this.authStatusKind === 'none') {
      return {
        kind: 'auth-required',
        authMethods: initAuthMethods,
        efforts: [],
        selectedEffort: null,
      };
    }

    const response = created as {
      configOptions?: RawConfigOption[];
      models?: { availableModels?: unknown[]; currentModelId?: unknown };
    } | null;
    const options = response?.configOptions ?? [];
    // 档位与模型来自同一份 configOptions —— 顺手取走，不然换源时会把强度控件一起弄丢。
    const effortOption = options.find((o) => o.category === 'thought_level');
    const efforts = toChoices(effortOption);
    const selectedEffort = typeof effortOption?.currentValue === 'string'
      ? effortOption.currentValue
      : null;

    const modelOption = options.find((o) => o.category === 'model');
    const configModels = toChoices(modelOption);
    const reportedModels = toAvailableModels(response?.models?.availableModels);
    const models = [...configModels, ...reportedModels.filter((model) => !configModels.some((known) => known.id === model.id))];
    if (models.length === 0) {
      // 这家 harness 说了 ACP，但没有模型选择这回事。不是错误，就是没得选。
      return { kind: 'ready', models: [], selected: null, efforts, selectedEffort };
    }
    return {
      kind: 'ready',
      models,
      selected:
        typeof modelOption?.currentValue === 'string'
          ? modelOption.currentValue
          : typeof response?.models?.currentModelId === 'string'
            ? response.models.currentModelId
            : null,
      efforts,
      selectedEffort,
    };
  }
}

/**
 * ACP 规定的「要先登录」错误码。
 *
 * 一手出处:各家打包进去的那份 ACP 库里,它与别的码并列写死在一张表上 ——
 * `authRequired → -32000`、`internalError → -32603`、`requestCancelled → -32800`
 * (实测 kimi-code 0.38.0 `dist/main.mjs`,mimocode 的 bundle 里那份 zod 联合也把 -32000
 * 列进了合法错误码)。⇒ 它是协议常量,不是某一家的私货,更不是文案。
 */
const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * 把协议给的 authMethods 数组归一成 `HarnessAuthMethod`;不是数组就返回空表。
 *
 * ⚠️ 这里从前只取 `id`/`name`/`description`,把 `type`/`args`/`env` 原地丢掉 ——
 *    于是「厂商在线上告诉我们该怎么登」被裁成一句话,咕咕再去插件里手抄一张登录命令表。
 *    实测(2026-08-27,d15,真起进程)那张手抄表与协议自报的**并不一致**:
 *    claude 的 ACP adapter 自报 `args: ['--cli','auth','login','--claudeai']`(以及第二条
 *    `--console`),而插件里手写的是 `['auth','login']` —— 两条命令、两个程序、两种账号。
 */
function toAuthMethods(raw: unknown): HarnessAuthMethod[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .map((m) => {
      const id = typeof m.id === 'string' ? m.id : '';
      return {
        id,
        name: typeof m.name === 'string' ? m.name : id,
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        ...resolveTerminalAuth(m),
        ...(Array.isArray(m.vars) ? { vars: toAuthVars(m.vars) } : {}),
        ...(typeof m.link === 'string' ? { link: m.link } : {}),
      } satisfies HarnessAuthMethod;
    })
    .filter((m) => m.id);
}

/**
 * 一条登录方式到底是不是「跑个终端」,以及怎么跑。
 *
 * ⚠️ 同一件事,实测有**三种**编码,只读规范那一种等于对四家视而不见
 * (2026-08-27 取证,每条都附出处):
 *
 *  1. **规范的判别符** —— `type: "terminal"` + 顶层 `args`/`env`。
 *     实测:`@agentclientprotocol/claude-agent-acp` 0.54.1(d15 真起进程差分)。
 *  2. **qwen 方言** —— 顶层无 `type`,信息塞在 `_meta: { type: 'terminal', args: [...] }`。
 *     出处:`QwenLM/qwen-code@fc0e827` `packages/cli/src/acp-integration/authMethods.ts:10-22`,
 *     发行包 `@qwen-code/qwen-code@0.22.2` 字节一致。
 *     成因不是任性:它钉的是 SDK 0.14.1,那一代的 `AuthMethod` 是**扁平**的
 *     (`{_meta?, description?, id, name}`),`type`/`args` 在类型上无处可放。
 *  3. **`terminal-auth` 方言** —— `_meta['terminal-auth']: { command, args, label }`,
 *     给的是**一条完整命令行**而不是要追加的参数。
 *     出处:`@github/copilot` 1.0.80 `app.js` 偏移 5625022。
 *
 * ❌ 不把三种拉平成一个 `args`:1 与 2 是追加、3 是整条替换。拉平就会拼出一条没人说过的命令。
 * ⚠️ `_meta` 规范上写着「Implementations MUST NOT make assumptions about values at these keys」——
 *    所以这里只认**这两种实测见过的具名方言**,形状对不上一律不认,退回 `agent`/`unknown`。
 *    ❌ 别把它扩成「凡是 _meta 里长得像命令的都试试」。
 */
function resolveTerminalAuth(m: Record<string, unknown>): Partial<HarnessAuthMethod> & {
  kind: HarnessAuthMethod['kind'];
} {
  const declared = authMethodKind(m.type);
  // 1. 规范那一种。
  if (declared === 'terminal') {
    return {
      kind: 'terminal',
      terminal: {
        style: 'append',
        args: Array.isArray(m.args) ? m.args.filter((a): a is string => typeof a === 'string') : [],
        ...(isStringMap(m.env) ? { env: m.env } : {}),
      },
    };
  }

  const meta = m._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const bag = meta as Record<string, unknown>;
    // 2. qwen 方言。
    if (bag.type === 'terminal') {
      return {
        kind: 'terminal',
        terminal: {
          style: 'append',
          args: Array.isArray(bag.args)
            ? bag.args.filter((a): a is string => typeof a === 'string')
            : [],
          ...(isStringMap(bag.env) ? { env: bag.env } : {}),
        },
      };
    }
    // 3. `terminal-auth` 方言 —— 只在 command 真是个字符串时才认。
    const legacy = bag['terminal-auth'];
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const entry = legacy as Record<string, unknown>;
      if (typeof entry.command === 'string' && entry.command.trim()) {
        return {
          kind: 'terminal',
          terminal: {
            style: 'command',
            command: entry.command,
            args: Array.isArray(entry.args)
              ? entry.args.filter((a): a is string => typeof a === 'string')
              : [],
          },
        };
      }
    }
  }

  return { kind: declared };
}

/**
 * 判别符归一。**缺省即 `agent`** —— schema 原文「When no `type` is present, the method is
 * treated as `agent`」(实测:codex-acp 1.3.0 的两条就都不带 `type`)。
 *
 * ❌ 认识不了的值不许当 `agent`:规范允许自定义类型(v2 文档写的是以 `_` 开头),
 *    把它当 agent 就会对着一个没读懂的方法发一个可能被协议禁止的请求。记 `unknown`,
 *    界面照旧说得出它的名字,但不给动作。
 */
function authMethodKind(raw: unknown): HarnessAuthMethod['kind'] {
  if (raw === undefined || raw === null) return 'agent';
  if (raw === 'agent' || raw === 'terminal' || raw === 'env_var') return raw;
  return 'unknown';
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}

function toAuthVars(raw: unknown[]): NonNullable<HarnessAuthMethod['vars']> {
  return raw
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .filter((v) => typeof v.name === 'string')
    .map((v) => ({
      name: v.name as string,
      ...(typeof v.label === 'string' ? { label: v.label } : {}),
      ...(typeof v.secret === 'boolean' ? { secret: v.secret } : {}),
      ...(typeof v.optional === 'boolean' ? { optional: v.optional } : {}),
    }));
}

/** JSON-RPC 错误。带着 `data.authMethods` —— 未登录时协议就是从这里把登录方式交回来的。 */
class AcpRpcError extends Error {
  constructor(private readonly payload: unknown) {
    // 原因走 `errorDetail`(与运行时回合失败那一行同一份,同一道去敏):ACP 的 Python SDK 把处理函数里
    // 没接住的异常一律包成 `-32603 Internal error`,真正那句话在 `data.details` 里。只取 `message`
    // 时,没配 provider 的 hermes 在界面上只剩一句「Internal error」,而它其实说了该运行 `hermes model`。
    super(redactSecrets(errorDetail(payload) ?? JSON.stringify(payload)));
    this.name = 'AcpRpcError';
  }

  /** 这个错误是不是「要先登录」；是就返回可用的登录方式，不是则 null。 */
  authMethods(): HarnessAuthMethod[] | null {
    const data = (this.payload as { data?: { authMethods?: unknown } })?.data;
    const raw = Array.isArray(data?.authMethods) ? data.authMethods : null;
    // ❌ 不按错误文案匹配 —— 与上面「没装按 errno 判」同一条规矩，这里之前自己破了例：
    // `/auth|login|.../i` 会把 `Unauthorized`、`authentication service unreachable`、任何含
    // `author…` 的 5xx 都读成「要先登录」，然后给出一个空的登录方式列表 —— 界面连"去哪登"
    // 都说不出，用户照着做也修不好。没有结构化字段就当「读不出来」，如实说原因。
    if (!raw) return null;
    return toAuthMethods(raw);
  }

  /**
   * 错误码是不是 ACP 的 `-32000`(要先登录)。
   *
   * 这一条与上面那条是**并列**的两个结构化判据,不是替代:qwen 把登录方式塞在 `data.authMethods`
   * 里,kimi 只回一个裸的 `-32000`。少了这一条,kimi 会被判成「读取失败」——
   * 界面告诉用户「坏了」,而真相是「去登录就行」。
   *
   * ⚠️ 仍然**不是**文案匹配:码表是协议自己的常量(见 ACP_AUTH_REQUIRED_CODE 抬头)。
   */
  isAuthRequiredCode(): boolean {
    return this.code() === ACP_AUTH_REQUIRED_CODE;
  }

  /** 对方回的 JSON-RPC 错误码;没有就 undefined。分类判错时这是**第一个**要看的数。 */
  code(): number | undefined {
    const code = (this.payload as { code?: unknown })?.code;
    return typeof code === 'number' ? code : undefined;
  }
}
