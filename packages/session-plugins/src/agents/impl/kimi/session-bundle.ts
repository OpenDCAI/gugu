import { harnessPlatform } from './platform';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  basename,
  join,
} from 'node:path';
import {
  materializeAcpSessionBundle,
  UNVERIFIED_SESSION_BUNDLE_DELIVERY,
} from '../../helpers/session-bundle';
import { agentHomeSegments } from '@gugu/session-core/agents/plugins';
import type {
  GeneratedArtifact,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionPromptBlocks,
  TomlOverlay,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';

/** 这一家在 registry 里的 id —— 独立 home 的目录名跟着它走。 */
const KIMI_PROVIDER_ID = 'kimi';

function kimiWorkspaceTrustPath(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = basename(normalized);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'workspace';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `workspace-trust/wd_${slug}_${hash}`;
}

/**
 * Kimi Code 的数据根。**咕咕把它指向自己那一份** —— 见本文件 descriptor 上的 `configRoot`
 * (独立 home)。机制在 `session-core` 的 `capabilities/config-root.ts` + `helpers/agent-home.ts`。
 *
 * ## 三个方案,只有第三个成立
 *
 *  · **不设它、沿用用户那份** ——(2026-08-27~08-28 的状态)一个用户文件都不碰,代价是
 *    `support_efforts` / `[thinking] effort` / 咕咕的 `[[hooks]]` 全部落不了地:
 *    它们**只**认 config.toml,而咕咕写不进用户的全局配置。
 *  · **合成 home**(每会话一个空临时目录)—— ❌ 已否决。它把用户的登录态、skills、
 *    历史全挡在外面,`sessions/` 每次新 uuid ⇒ `sessions: {kind:'resumable'}` 与 `-S/-C`
 *    恒等于「没有可续的会话」。**登录写真 home、会话读临时目录,两者永不相遇。**
 *  · **独立 home** ✅ —— 首次触碰时把用户那份 `~/.kimi-code` **整份复制**成咕咕自己的一份,
 *    此后两份彻底分家(不同步、不合并、不回读)。第一次在咕咕里打开 kimi,与用户自己打开它,
 *    看到的是同一个东西;之后各自维护,所以**不存在漂移**。
 *
 * ⚠️ **登录写哪儿**这条以前是个洞,现在堵上了:`kimi login` 由咕咕经 `plugin-host.ts` 的
 *    `buildLoginCommand` 起,而它和起会话走的是**同一个** `resolveSpawnContext` ——
 *    两边拿到的 `KIMI_CODE_HOME` 必然是同一个值。
 *    (顺带纠正本注释的旧版本:它断言 `KIMI_CODE_HOME` 不在 `AGENT_ENV_VARS` 白名单里(今天是 kimi 的 `shellEnv.passThrough`)。
 *     **不成立** —— `agent-env.ts` 第 75 行就是它。那句话写下之后表被补过,而注释没跟。)
 *
 * ❌ **不许**「给 config.toml 软链回真 home」当补丁:那正是 codex 那条注释点名的绷带,
 *    而且 `hooks.ts` 会**经软链写穿到用户真文件**。独立 home 的复制因此一律解引用软链
 *    (见 `helpers/agent-home.ts` 的 `copyTree`)。
 */
export const KIMI_HOME_ENV = 'KIMI_CODE_HOME';

/**
 * 身份自述 —— **两条腿的答案不一样**，所以按腿声明（`kind: 'per-surface'`）。
 *
 * ## 终端腿：有载体，已接通（`prompt-file-argv`）
 *
 * 咕咕把一份 agent 档写进**自己的** `GUGU_HOME`，再用 `--agent-file` 指过去。一条用户文件
 * 都不碰、不搬家、不进用户的项目目录，档的路径是现生成的 uuid —— behavior
 * `agent-config-boundary` 的三条判据全过。落点与硬约束见 `agentFileDelivery` /
 * `deliversAgentFile` 抬头。
 *
 * ⚠️ **上一版在这一格记的是「TUI 腿也用不了」，那个结论已被推翻。** 当时的理由是
 * 「`--agent-file` 与 `-S`/`-C` 互斥，而按 lifecycle 设闸挡不住『isResuming 为真但还没有
 * provider session id』那一格」。前半句对、后半句的**结论**错：挡不住不等于没法挡，
 * 缺的是把 `isResuming` 这个真值递到物化层（本次已补，见
 * `SessionMaterializationContext.isResuming`）。而「续跑不发就等于没投递」也不成立 ——
 * kimi 在建会话时把档的**正文**快照进会话记录（0.39.0 的 session metadata 存
 * `agentProfileCatalog`，续跑走 `restoreSnapshot` 读回来），续跑起来的仍是同一个身份。
 *
 * ## 协议腿：没有**系统位**，所以走 ③（`session-context`）
 *
 * 同一段话以**用户级载体**进到首轮的输入里。⚠️ 这不是降级 —— behavior
 * `agent-context-injection`「②③ 只差载体」：身份仍是系统提示词，照样不展示给用户。
 *
 * 为什么不得不走 ③ —— 0.39.0 上四个面全查过一手，**没有一条系统位够得着**：
 *  · **命令行** —— `kimi acp` 只注册 `--login` / `--region`
 *    （`registerNativeAcpCommand`，根命令那一排 option 一个都没继承）。
 *  · **协议字段** —— `newSession` 只读 `cwd` / `additionalDirectories` / `mcpServers`。
 *    `_meta` 在 zod schema 里有，但**不往下传**。而 `additionalDirectories` 只喂
 *    `loadAdditionalDirsInfo`（一份目录清单）：`prepareSystemPromptContext` 给
 *    `loadAgentsMdForRoots` 传的 workDirs 是**写死的 `[kaos.getcwd()]`**，附加目录里的
 *    `AGENTS.md` 一个字都读不到。
 *  · **环境变量** —— 把 bundle 里的 `KIMI_*` 读取点精确枚举（`process.env.X` / `env["X"]`
 *    完整匹配，避免前缀误报），约 60 个键**没有一个**携带提示词内容；阳性对照
 *    `KIMI_MODEL_NAME`（×5 命中）证明枚举器本身看得见。
 *  · **文件** —— `<brandHome>/SYSTEM.md` 与 `agents/` 随 `KIMI_CODE_HOME` 走 ⇒ 要用就得
 *    另造一份配置根；`extra_agent_dirs` 要写用户的 `config.toml` 且会顶掉**用户自己**
 *    终端里的默认档；项目级 agent 档锚在 git 根、且要顶掉默认档就得叫 `agent`，
 *    同一个 worktree 里两个会话会互相覆盖身份。三条都被 behavior 判否。
 *
 * ⇒ 四个面都没有系统位 ⇒ 落到 ③。
 *
 * ❌ 这**不等于**「厂商做不到」：`SYSTEM.md` 确实到得了 ACP 会话
 *    （`sessions.create → resolveMainAgentProfile → catalog.getDefault()` 这条链是通的），
 *    只是它随 `KIMI_CODE_HOME` 走 —— 用它就得另造一份配置根，而 behavior
 *    `agent-config-boundary` 判否。**够不着是咕咕不肯搬家，不是它不存在。**
 *
 * ⚠️ 上一版这一格记的是 `none + violates-zero-residue`（一格能力欠账）。那个口径已经不对：
 *    ③ 是一条**正规通道**，不是兜底也不是降级。继续记欠账会让一件已经做完的事一直挂在
 *    待办上，并把这一家挡在咕咕集成档外面。
 */

/**
 * 终端腿的 MCP —— **2026-08-28 接通**(独立 home 落地之后)。
 *
 * 载体是 `<配置根>/mcp.json`,形状取自 kimi 自己的 `McpServerHttpConfigSchema`
 * (实测假端点收到 initialize / notifications/initialized / GET(SSE) / tools/list 四个真实请求,
 * 模型工具表 26 → 27;三重变异对照都跟着变 —— 见 `./mcp.ts` 的 `kimiMcpAdapter`)。
 *
 * ## 从前挡住它的是什么,现在为什么不挡了
 *
 * 挡住它的从来不是「没有载体」,是**那个载体是用户的全局文件** `~/.kimi-code/mcp.json`,
 * 而咕咕的 MCP server 是**每会话**的地址与令牌 —— 写进去 = 用户自己敲 `kimi` 时也带着
 * 一条连不通的 server(kimi 的 MCP 条目 schema 里只有静态 `enabled`,没有 hook 那样的
 * `if [ -n "$GUGU_HOOK_PORT" ]` 自我禁用闸)。
 *
 * **独立 home 把这个前提整个换掉了**:咕咕现在写的是自己那份
 * `<GUGU_HOME>/agent-homes/kimi/.kimi-code/mcp.json`。用户自己敲 `kimi` 读的仍是他自己的
 * `~/.kimi-code/mcp.json`,**一个字节没动**。⇒ 那笔取舍不存在了,不需要再等谁拍板。
 *
 * ⚠️ 每会话整份重写(artifact,不是 merge):这份文件从头到尾就是咕咕的,里面只有咕咕的
 * server。❌ 不要改成合并 —— 合并意味着上一次会话的**过期地址与令牌**会一直留着,
 * 而那正是「连不通的 server」那个症状本身,只不过换了个目录。
 */
const KIMI_MCP_CONFIG_BASENAME = 'mcp.json';

const unverifiedAutonomy = {
  kind: 'none',
  degraded: {
    code: 'unverified',
    reason: 'Kimi autonomy is not yet measured on the ACP surface.',
  },
} as const;

/**
 * kimi 的**终端腿:已开启**(2026-08-28,随独立 home 一起)。
 *
 * ## 它为什么曾经关着,以及为什么现在能开
 *
 * 关它的理由只有一条,而且很具体:**咕咕的 MCP 在这条腿上唯一的载体是用户的全局文件**
 * `~/.kimi-code/mcp.json` —— 没有 flag、没有环境变量。而咕咕的 server 是每会话一个地址
 * (app 每次启动随机端口)加一个令牌,写进去 = 用户自己敲 `kimi` 时也带着一条连不通的 server。
 * (❌ 别拿 `[[hooks]]` 当先例:hook 的命令体自带 `if [ -n "$GUGU_HOOK_PORT" ]` 的自我禁用闸,
 *  用户自己跑时是惰性的;MCP 条目的 schema 里只有静态 `enabled`,没有等价的闸。)
 *
 * **独立 home 把这条理由整个消掉了**:咕咕现在写的是自己那份
 * `<GUGU_HOME>/agent-homes/kimi/.kimi-code/mcp.json`,用户那份一个字节没动。
 * ⇒ 见 `mcpConfigArtifact`。
 *
 * 另一半(身份自述)本来就是通的:`--agent-file` 那一整套有一手出处、有用例。它与续跑的
 * `-S`/`-C` 互斥,而「没有原生 session id 就不算续跑」已经在
 * `resolve-agent-session-command.ts` 里处理掉了。
 *
 * ⚠️ 翻回 `false` 之前先想清楚:`resolveSessionTuiHostAdapter('kimi')` 在关闭状态下**会抛**
 *    (没有 `sessionpage['tui']`),所以界面上 Chat UI 那个开关会重新**锁死在开**
 *    (`initial-session-section.tsx`)—— owner 2026-08-28 实测时正是被这个锁挡住的。
 */
export const KIMI_SESSION_TUI_ENABLED = true;
const SESSION_TUI_ENABLED = KIMI_SESSION_TUI_ENABLED;

/**
 * 终端腿的中断键 —— 取证见下。⚠️ 抽成常量是因为 descriptor 里那一格要跟着
 * `SESSION_TUI_ENABLED` 开关摊开;取证与结论一个字都没变。
 */
const KIMI_SESSION_TUI_INTERRUPT = {
  sequence: '\u001b',
  evidence:
    'MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6 '
    + 'apps/kimi-code/src/tui/controllers/editor-keyboard.ts:243-247 —— onEscape 的 '
    + "streamingPhase !== 'idle' 分支直接 cancelCurrentStream();对照同文件 :196-203 的 onCtrlC,"
    + '同一分支前面隔着一道 `if (this.clearEditorTextIfPresent()) return;`(:521-526),'
    + '输入框非空时 0x03 只清框、不中断。厂商用例 '
    + 'apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts:3764-3779 断言第一次 onCtrlC 后 '
    + 'session.cancel 未被调用、第二次才被调用。审批框 '
    + "components/dialogs/approval-panel.ts:261-269 把 escape/ctrl-c/ctrl-d 归为同一个 'rejected',"
    + '故 Esc 不会比 Ctrl-C 多伤一格;取证 2026-08-24',
} as const;

export const kimiSessionBundleDescriptor = {
  // 托管侧:实测证明 env 注入的模型在 kimi 内部是 `__kimi_env_model__`,
  // `support_efforts` 挂不上去 ⇒ 档位只能落 config.toml(dd0463a634)。
  injectionMode: 'managed-config-root',
  platform: harnessPlatform,
  // `KIMI_CODE_HOME` 与 `CODEX_HOME` / `QWEN_HOME` 同类:用户把数据根挪过家时唯一的告知方式;它也是 `kimi login` 拿到的那份环境。
  shellEnv: { passThrough: ['KIMI_API_KEY', 'KIMI_CODE_HOME'] },
  // 平台令牌同时在两处:咕咕自有 config.toml 的 `providers.<gugu>.api_key`(`modelConfigOverlay`)与宿主
  // `kimi-model-env` 物化的 `KIMI_MODEL_API_KEY`。两处都只在 spawn 时读 ⇒ 到期按原形态重开。
  credentialLifecycle: {
    'acp': {
      delivery: 'child-process-env+process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
    'tui': {
      delivery: 'child-process-env+process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: SESSION_TUI_ENABLED ? ['acp', 'tui'] : ['acp'],
  sessionpage: {
    // ACP 腿可寻址 —— gugu-im 经 `session/new` 的 `mcpServers` 送进去（工具真进了模型的
    // 工具表），所以消息发得出去。
    //
    // ⚠️ **2026-08-27 订正：这里原先那段权衡是空的，别再照着它推理。**
    //
    // 原文说「撤掉 `addressable` 的代价是 kimi 的 ACP 会话整个从选择器里消失，所以先留着」。
    // 真机实测（MBP，隔离实例，本分支 `428ee6687`）：**kimi 本来就已经不在选择器里了** ——
    // 设置页与 composer 的清单都只有 7 家（claude / codex / copilot / mimocode / opencode /
    // qoder / qwen），kimi 一个字都没有。
    //
    // 因为把它拿掉的是**另一道闸**：`plugin-registry.ts` 的 `listPlugins()` 要
    // `agentSupportTier === 'supported'` **且** `probeGuguIntegration().integrated`，
    // 而后者要五维齐全。逐家算过的读数：kimi 是
    // `{tier:'supported', integrated:false, mcp:true, env:true, model:true, autonomy:true,
    //   promptBlocks:false}` —— **只差 promptBlocks 这一维**，正是随合成 home 一起撤掉的那维。
    // ⇒ 保不保留 `identity: 'addressable'` 对「会不会消失」**没有影响**，那个权衡从一开始
    //   就问错了闸。kimi 退出咕咕集成档这件事本身是有意的。
    //
    // 那么这一格为什么仍是 `addressable`？因为它说的是**寻址**，不是自述：gugu-im 经
    // `session/new` 的 `mcpServers` 真进了模型的工具表，消息确实发得出去。本仓先例一致：
    // 二十多家 tui 腿都是 `promptBlocks: none` + `identity: 'addressable'` 这个组合
    // （例:`impl/commandcode/session-bundle.ts`;2026-09-21 之前这里引的是 letta,那一家随
    //  #6097 删掉了,先例本身没变）。
    'acp': { identity: 'addressable', messageTransport: 'router' },
    // ⚠️ 与 `surfaces` 同一个开关:registry 会拦「声明了 sessionpage 集成却没有那条 surface」。
    ...(SESSION_TUI_ENABLED
      ? {
          'tui': {
            identity: 'addressable',
            messageTransport: 'local-session',
            // 入站:**收得进**(轴缺席 = deliverable,与其余三十多条 local-session 终端腿同形)。
            //
            // 这一格 2026-08-29(#4670)起曾是 `inbound: 'none'`,理由是「kimi 0.39.1 没有原生入站
            // 通道,而 pty 打字首句不可靠」。前半句今天仍成立(`-p/--prompt` 是 headless、管道
            // stdin/位置参数/serve/attach 都承载不了),后半句不成立了:打字不可靠的根因是 kimi 的
            // 粘贴突发判定把回车改成换行(见 `tuiEditorOverlay`),关掉之后逐字符注入 7/7 进对话流
            // (2026-09-04 MBP 真机,对照 0/3)。入站走的正是同一条注入路
            // (`keystroke-injection.ts` 的 `injectImmediately`),首句能到,第二条起就能到。
            //
            // `inbound: 'none'` 拦的是 `session_message` / `agent.deliver` 这条 agent 之间的路
            // (`assertMessageableTarget`);owner 私信走 `sendMessage` 本来就不经这道闸。
            // owner 2026-09-04 真机撞上它:kimi 让另一个 Kimi Agent 回话,被
            // 「declares no inbound channel」拒掉。同一条腿「你发得到、agent 发不到」没有道理。
            //
            // ⚠️ 这一格仍不写成 `messageTransport: 'none'`:那会连**身份供给**一起否掉
            // (`canProvisionSessionpageAgent` 同时读那一格),把 #4403 用独立 home 买到的 MCP 载体
            // 与 `--agent-file` 身份自述一并丢掉。
            // ⚠️ kimi 若将来提供 serve/attach 或进程内控制通道,应按原生通道升级并移除
            // keystroke 依赖;当前无原生通道时,keystroke 是经 owner 授权的唯一 TUI 入口。
          },
        } as const
      : {}),
  },
  units: {
    // MCP —— 走 ACP `session/new` 的 `mcpServers`，**零落盘**。
    //
    // 实测 @moonshot-ai/kimi-code@0.38.0：假 MCP 端点收到 initialize /
    // notifications/initialized / GET(SSE) / tools/list 四个真实请求，`Authorization: Bearer`
    // 与自定义头逐字带上；模型的工具表 26 → 27，新增的正是 `mcp__<server>_<tool>`。
    // 三重变异对照（token / header 值 / server 名）三个读数全部跟着变 ⇒ 判得了假。
    //
    // ⚠️ 它的 ACP 形状里 `headers` 是 `{name,value}` **数组**（不是对象），而通用物化产出的
    //    正好是这个形状。⚠️ 这条通道**只吃 http/sse**，stdio 会抛错。
    // MCP —— **两条腿答案不同**。
    //
    // ⚠️ 这一格 2026-08-28 之前是扁平声明(= 两条腿都 native)。`acp-session` 的载体是
    //    `session/new` 的 `mcpServers`,**终端腿上没有这个东西**:PTY 那条路只取
    //    `argsAppend` / `env`,产出的 `acp` 载荷被整个忽略。而通用物化的 `unitReport` 按
    //    descriptor 报数 ⇒ 终端腿恒定报 `mcp: loaded`。owner 2026-08-28 实测:那条会话的
    //    能力报告写着 `mcp: loaded`,而 `~/.kimi-code/mcp.json` 根本不存在,咕咕的工具一个没有。
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        // ⚠️ 两条腿**载体不同**,所以仍然按腿声明:协议腿走 `session/new` 的 `mcpServers`
        //    (PTY 那条路只取 argsAppend/env,产出的 `acp` 载荷被整个忽略);终端腿走
        //    咕咕自己那份 `mcp.json`。声明成扁平 native 会让终端腿恒报 `mcp: loaded`
        //    而实际一个工具都没有 —— owner 2026-08-28 实测过的那个形状。
        //
        // ⚠️ 合 dev 时的取舍(2026-08-31):dev 上这一格是 `none + unverified`,理由是
        //    「唯一已知载体 `~/.kimi-code/mcp.json` 是**用户的全局文件**,而咕咕的 server
        //    是每会话的地址与令牌」。独立 home 把那个前提换掉了 —— 咕咕写的是**自己那份**
        //    配置根里的 mcp.json,不碰用户的。且已有真机读数:终端腿真会话里
        //    `tools/list` 有返回(owner MBP,2026-08-28)。⇒ 保留 native,❌ 别回退成 unverified。
        'tui': { kind: 'native', channel: 'config-file' },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    // 模型 —— `KIMI_MODEL_*` 一族纯环境变量，零登录、零落盘。
    // 形状与证据见 `capability-bundle.ts` 的 `kimi-model-env` 分支。
    // ⚠️ 2026-08-28 从 `process-config`(= `KIMI_MODEL_*` env)改成 `config-file`。
    //    不是换个说法:env 注入的模型在 kimi 内部叫 `__kimi_env_model__`,拿不到
    //    `support_efforts`(那个键只有 config.toml 有)⇒ 思考控件恒是 off/on 开关。
    //    逐格实测见 session-bundle 的 `modelConfigOverlay`。
    model: { kind: 'native', channel: 'config-file' },
    // ⚠️ 自治级别这一维**还没量准**，所以如实记 unverified。
    //    已知：`[[permission.rules]]` 在 headless 与 ACP 两条路径上都**静默无效**
    //    （`doctor` 说文件合法、同一文件里的 provider 定义在 ACP 上确实被读到、代码里规则也
    //     确实传进了 Session 构造器，但行为上就是不生效 —— 三个阳性对照都做了）。
    //    ⇒ ❌ 别去接那张规则表。真正可用的硬闸是 `[[hooks]] event="PreToolUse"`（实测拦得住），
    //    但「咕咕的两档能不能声明式地下发」还差一轮测量，测准之前不声明。
    autonomy: unverifiedAutonomy,
    // 系统提示 —— **两条腿答案不同**，逐条出处见文件顶部「身份自述」那段抬头。
    //
    // ⚠️ 这一格从前是 run-scoped `$KIMI_CODE_HOME/SYSTEM.md`：它确实送到了，代价是把用户的
    //    登录、咕咕自己的 hook 与全部会话历史一起搬到一个每次都不同的临时目录里。那笔交换
    //    不成立（见 `KIMI_HOME_ENV` 抬头）——**而「持久化那个合成 home」也不成立**：
    //    用户那份 + 每个 agent 各一份 = N+1 份互不相干且各自漂移的状态，格式又由上游定义。
    //    两种形态都堵，所以这条路整个否掉，不是选了其中一种代价。
    //    （behavior `agent-config-boundary`「默认不为咕咕另造一份配置根」）
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        // 终端腿:咕咕自己目录里的一份 agent 档 + `--agent-file` 指过去。
        'tui': { kind: 'native', channel: 'prompt-file-argv' },
        // 协议腿:没有系统位,所以走 ③ —— 同一段话以**用户级载体**进到首轮的输入里。
        // ⚠️ 这**不是**降级(behavior `agent-context-injection`:「②③ 只差载体」),
        //    也❌ 不是拿终端腿那条顶上来充数 —— `kimi acp` 根本不收 `--agent-file`,
        //    这条走的是 `session/prompt` 的内容,与那条是两个不同的真投递。
        'acp': { kind: 'native', channel: 'session-context' },
      },
    },
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  /**
   * TUI 腿的中断键 —— **Esc(\u001b),与别家一致**。
   *
   * ⚠️ **这一条在 2026-08-24 被翻过面**:原来写的是 `Ctrl-C`,理由是「这一家是反过来的」。
   * 那个理由来自**旧产品 kimi-cli 的文档站**(`.../kimi-cli/en/reference/keyboard.html`),
   * 而这份 descriptor 已经钉到 **Kimi Code**(见下方安装源那段)。在新产品的源码里,
   * `Ctrl-C` 是**会被输入框吃掉**的,`Esc` 才是可靠的外部中断。
   *
   * 逐格对比(全部读自 `MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
   * `apps/kimi-code/src/tui/controllers/editor-keyboard.ts`,行号为该 sha 上的实际行):
   *
   *   | 场景                 | `Ctrl-C` (:167-215)               | `Esc` (:225-254)         |
   *   |----------------------|-----------------------------------|--------------------------|
   *   | 生成中·输入框**有字** | **只清空输入框然后 return**,本轮照跑 | 取消本轮                 |
   *   | 生成中·输入框空       | 取消本轮                           | 取消本轮                 |
   *   | 压缩中               | 同样先清框(:190)                   | 直接取消压缩(:238)       |
   *   | 审批框               | rejected                           | rejected(**同一分支**)   |
   *   | 空闲                 | arm 退出,**再来一下 `host.stop()`** | arm 撤销,再来一下开撤销选择器 |
   *
   * 关键那两行(`:196-203`,原文):
   *   `if (host.state.appState.streamingPhase !== 'idle') {`
   *   `  this.clearPendingExit();`
   *   `  if (this.clearEditorTextIfPresent()) return;`   <-- **就是这道门**
   *   `  this.cancelCurrentStream();`
   * 而 `onEscape` 的同一分支(`:243-247`)**没有**这道门,直接 `this.cancelCurrentStream()`。
   * `clearEditorTextIfPresent`(`:521-526`)在输入框非空时清空并返回 `true`。
   * => 咕咕写下去的那个 0x03,只要用户输入框里有字,就**只清框、不中断**,而 `pause` 显示绿。
   * 厂商自己的用例把这个形状钉死了(`apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts:3764-3779`):
   * 第一次 `onCtrlC` 后 `expect(session.cancel).not.toHaveBeenCalled()`,第二次才 `toHaveBeenCalledTimes(1)`。
   *
   * 旧注释里「❌ 写 Esc 会在有待答提问时把用户那一问跳过」—— **在这个产品上是假的**:
   * `apps/kimi-code/src/tui/components/dialogs/approval-panel.ts:261-269` 把
   * `Key.escape` / `Key.ctrl('c')` / `Key.ctrl('d')` 归到**同一个** `onResponse({ response: 'rejected' })`,
   * 两个字节在审批框里一模一样,谈不上谁更伤。
   *
   * 失败方向(为什么 Esc 的最坏情况反而更轻):两者在**空闲**时都会 arm 一个双击窗口,但
   * Ctrl-C arm 的是 `pendingExit` —— 再来一下就 `host.stop()` **杀掉会话**(`:205-209`);
   * Esc arm 的是 `pendingUndoEsc` —— 再来一下只是开一个撤销选择器(`:249-253`)。
   * => 误发 Esc 最坏是弹个选择器,误发 Ctrl-C 最坏是把用户的会话干掉。
   *
   * ⚠️ 还有三条分支排在 streaming 前面、会把 Ctrl-C/Esc 都先吃掉:`host.cancelInFlight`(:168,
   * 只由 login / provider 选择器设置)与两条 `btwPanelController`(:178/:182,用户开了 `/btw` 面板时)。
   * 这几条对正常一轮不生效,但**面板开着时任何一个字节都中断不了本轮** —— 这一格今天没接线去检测,
   * 属已知边界,别声称覆盖到了。
   *
   * ⚠️ 这里**不动** `coexistence.pause`:kimi 是双腿的家,pause 记 ACP 腿更强的 `protocol-cancel`,
   * 中断键只由本字段记录(判据见 core 的 `tuiInterruptSurfaceRequirement`)。
   */
  // ⚠️ 与 `surfaces` / `sessionpage` 同一个开关 —— registry 的校验器明写「tui interrupt
  //    declared without a tui surface: the bytes have nowhere to go」。取证照旧留着,
  //    终端腿一开就跟着回来。
  ...(SESSION_TUI_ENABLED ? { sessionTuiInterrupt: KIMI_SESSION_TUI_INTERRUPT } : {}),
  coexistence: {
    // 这四条都由 ACP 腿(`surfaces` 含 'acp',provider.acp = createNativeAcpBehavior)提供,
    // 与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    //  · plan:decode 出 { kind:'plan', entries } 后由 reducer/item-fold 折进 transcript。
    //    ⚠️ 这一条上游侧也坐实了,而且**两代产品都发**(所以下面那段「两代同名」的悬案
    //    不影响这一维):新 `MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
    //    `packages/acp-server/src/events-map.ts:396-415` 的 `todoListToSessionUpdate()` 把
    //    TodoList 投影成 `{ sessionUpdate: 'plan', entries }`(`acp-adapter` 那份 :436 同形);
    //    旧 `MoonshotAI/kimi-cli@cbc15c076d17f70fec9f89c90c0502e68657f505`
    //    `src/kimi_cli/acp/session.py:580-583` 发 `AgentPlanUpdate(session_update="plan", entries=…)`。
    //    ❌ 别拿 mimocode 那条「ACP 桥不转发 plan」类推到这里 —— 逐家验过,这一家是发的。
    //  · observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState
    //    产出 isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    //  · askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options
    //    的待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //    resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕
    //    没通,❌ 不许声明。
    //    另有 event-stream 通道:hooks.ts:18,19,21 把 Notification / Stop / SessionEnd 经
    //    makeStdinHookCommand POST 到 GUGU_HOOK_PORT(消费方 宿主 agent-hook-service 的 deriveAgentStatus);
    //    单维只能记一个通道,这里取信号更全的 acp-update —— 它报「本轮在飞」,
    //    hook 链主要报「转空闲」。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // memory:对应下面 `capabilities.memory` 登记的那两个 AGENTS.md —— 登记了文件,
    //    宿主 `AgentPluginHost.readMemoryFiles` 就真读得回来。
    memory: { kind: 'native', channel: 'agents-md' },
    // introspection:走 ACP 的 `available_commands_update`(通道 `running-engine`)。
    //    咕咕这一侧的链是通用的(acp/reducer/reducer.ts:511 -> config.availableCommands -> composer);
    //    厂商这一侧**逐家验过了,而且这一家的两代答案相反**,所以不能照 todo 那一维「两代都发」的捷径:
    //     · 新 Kimi Code(`MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`)**报的是用户自己的东西**:
    //       `packages/acp-server/src/session.ts:438-461` 的 `resolveCommands()` 把
    //       `ACP_BUILTIN_SLASH_COMMANDS` 与 `buildAcpSkillSlashCommands(this.skills)` 并起来发,
    //       `this.skills` 来自 `:369` 的 `session.skills.list()`,`skills.changed` 还会重推(`:340-342`)。
    //       skill 根(`packages/agent-core-v2/src/features/skill/catalog/skillRoots.ts:8-11`)是
    //       `$KIMI_CODE_HOME/skills`(默认 `~/.kimi-code/skills`)、`~/.agents/skills`、
    //       项目 `.kimi-code/skills`、项目 `.agents/skills` —— 全是用户目录。
    //       最硬的一条:**厂商自己的 ACP 用例把真文件写到盘上再从线上收回来**
    //       (`packages/acp-server/test/skills.test.ts:108-113,163-171`:写
    //       `~/.kimi-code/skills/acp-fixture` 后 `waitForSessionUpdate('available_commands_update')`
    //       里断言拿到 `skill:acp-fixture`)。
    //     · 旧 kimi-cli(`@cbc15c076d17f70fec9f89c90c0502e68657f505`)**报的是死表**:ACP server
    //       `src/kimi_cli/acp/server.py:183-193` 发 `soul_slash_registry.list_commands()`,那个
    //       registry(`src/kimi_cli/soul/slash.py:34`)只装 `@registry.command` 注册的内建命令;
    //       它**有**用户 skill,但那份合并表(`soul/kimisoul.py:854-895`)的唯一消费者是 shell UI
    //       (`ui/shell/__init__.py:204`),ACP server 从不碰。
    //    => 这一格成立**是因为 descriptor 已经钉到 Kimi Code**。哪天有人把它改回旧产品,
    //       这一行必须一起撤掉 —— 考卷那条 `running-engine` 只验「有没有 ACP 腿」,
    //       挡不住「腿在但报的是死表」(它自己的注释里写明了这个边界)。
    // ⚠️ 已知边界,别声称覆盖到了:`userFileSkillSource.ts:46-48` —— 一旦 host 传了 `--skill-dir`,
    //    用户那几个根**整个失效**、只剩传进来的。咕咕的 ACP 路径不传(在 `packages/acp-server/src`
    //    里搜 `skillDirs` 零命中,同一条命令在 `apps/kimi-code/src/cli/run-prompt.ts:128` 有命中
    //    => 尺子会响),所以默认路径上用户根是活的。
    introspection: { kind: 'native', channel: 'running-engine' },
    // ⚠️ 这里**没有** `history`,但它的欠因与另外八家不同,别照抄那条通用理由。
    //    棘轮说明里写的是「闭源家拿不到当前格式的真样本,编样本=自证循环」——
    //    **那句对这一家不成立**:Kimi Code 是公开仓(`MoonshotAI/kimi-code`,今日仍在推),
    //    它的会话日志就是**逐行 JSON**,写者与读者都在源码里:
    //     · `packages/agent-core-v2/src/persistence/backends/node-fs/appendLogStore.ts`
    //       —— `append(scope, key, record)` 攒批后落盘,`read()` 按行 TextDecoder 解;
    //     · 字节层 `.../node-fs/fileStorageService.ts` —— `(scope, key)` 直接映射成
    //       `<baseDir>/<scope>/<key>` 的文件路径;
    //     · 落点根由 `IBootstrapService.scope(...)` 给(仓内 skill 文档
    //       `.agents/skills/agent-core-dev/persistence.md` 的三层模型那节写明了这条分工),
    //       用户目录默认 `~/.kimi-code`(与 skill 根 `$KIMI_CODE_HOME/skills` 同源)。
    //    ⇒ 真正欠的是两件,都不是「拿不到格式」:
    //      1. `packages/core/src/local/agent/transcriptSources/` 里还没有 kimi 这一份 spec
    //         (今天只有 claude-code 与 codex 两家进了这条路);
    //      2. **一份真跑出来的 transcript**。按本仓「外部协议要拿真样本验」的规矩,
    //         照着写者源码构造样本再拿它验读者 = 自证循环,所以这一条仍然拦着 ——
    //         但它拦的是**验证**,不是**调研**。差一台真装过 Kimi Code 的机器,不差事实。
  },
  /**
   * ⚠️ **两代产品同名** —— 这是本家这一波最值钱的读数。
   *
   * 「kimi」今天有两个产品,**两个都装出一个叫 `kimi` 的可执行文件**:
   *  · 旧:`MoonshotAI/kimi-cli`(Python)。sha cbc15c076d17f70fec9f89c90c0502e68657f505 的
   *    README.md:11-12 原文:「**Kimi CLI is evolving into [Kimi Code CLI]** … Installing Kimi Code
   *    CLI automatically migrates your configuration and sessions. **This project will be gradually
   *    wound down**」。家目录 `~/.kimi/`。
   *  · 新:`MoonshotAI/kimi-code`(TypeScript,npm `@moonshot-ai/kimi-code`)。
   *    sha 243f348329fc15e857dcaa0ae3cfe514729bd7a6。家目录 `~/.kimi-code/`(`KIMI_CODE_HOME`)。
   *
   * **咕咕这份 descriptor 现在同时指向两个产品**,四条互相矛盾的线索:
   *  · `hostDependency.installCommands` 用 `https://code.kimi.com/install.sh` —— 实测 302 到
   *    `https://cdn.kimi.com/binaries/kimi-cli/install.sh`,该脚本抬头原文
   *    「# Legacy kimi-cli (Python) installer - DEPRECATED.」并指向
   *    `https://code.kimi.com/kimi-code/install.sh`。
   *    ❗ **但「所以装的是旧产品」是错的 —— 这一波实测把它推翻了,而且方向正相反。**
   *    读完那 134 行脚本的分支逻辑:`KIMI_CLI_FORCE_OLD` 没设时,它经 `/dev/tty` 弹一条
   *    「Press Enter to install Kimi Code (auto-installs in 30s)」的横幅,`read -t 30`
   *    **超时即走默认分支 `install_kimi_code`**;只有两种情况才落到旧产品:显式 `KIMI_CLI_FORCE_OLD=1`,
   *    或**没有控制终端**(它自己写的「Non-interactive environment detected」)。
   *    而咕咕装依赖走的是 **pty**:`apps/desktop/electron/session/main/core/dependencies/install-runner.ts:65-102`
   *    的 `runLocalInstallCommand()` 用 `spawnLocalPty({ cols: 80, rows: 24 })` 起 shell,
   *    `waitForInstallPty`(同文件 :46-63)只收 `onData`、**没有任何 write 通道也没有超时**。
   *    ⇒ 有 tty、没人敲键、等得起 30 秒 ⇒ **咕咕的安装按钮装的是 Kimi Code(新),不是 kimi-cli**,
   *    代价是白等 30 秒,且用户在界面上看不到那条横幅(pty 输出只在失败时才作为报错回显)。
   *    实测:把该脚本两个安装函数换成 `echo BRANCH=…`(判定逻辑一字未改)后三条件跑 ——
   *    ①pty + 无输入 → `BRANCH=KIMI_CODE`;②`KIMI_CLI_FORCE_OLD=1` → `BRANCH=LEGACY_KIMI_CLI`;
   *    ③`setsid` 无控制终端 → `BRANCH=LEGACY_KIMI_CLI`。②③是阳性对照:这把尺子确实读得出旧分支。
   *    (kimi-code 的安装脚本把二进制装到 `${KIMI_INSTALL_DIR}/bin/kimi`,并自带一段
   *     `LEGACY_BIN="kimi"` 的迁移/遮蔽逻辑 —— 所以装完之后 `binaryNames: ['kimi']` 命中的是新产品。)
   *  · `updates.releaseSource.repo` = `moonshotai/kimi-cli`、`websiteUrl` 与
   *    `sessionTuiInterrupt.evidence` 引的键位表也都在旧产品的文档站 ⇒ 旧。
   *    ❗ 与上一条合起来这已经是一个**能自己发作的 bug**,不只是口径不齐:安装装的是 Kimi Code
   *    (版本号形如 `0.38.0`,`gh release list --repo moonshotai/kimi-code` 最新 `@moonshot-ai/kimi-code@0.38.0`),
   *    更新检查却去问 `moonshotai/kimi-cli` 的 releases(最新 `1.49.0`,最后一发 2026-07-16,项目已在收尾)。
   *    `0.38.0 < 1.49.0` 恒成立 ⇒ 这一家会**永远显示有更新可装**,而那条更新永远装不上对的东西。
   *  · 本目录 `hooks.ts` 的 `KIMI_CONFIG_PATH` 是 `.kimi-code/config.toml`、
   *    `KIMI_LEGACY_CONFIG_PATH` 才是 `.kimi/config.toml` ⇒ **新**。
   *  · 本文件 `injectKimiHooksIntoInlineConfig` 去改 `--config <文本>` 这个旗标 —— 它**只在旧产品上
   *    存在**(`src/kimi_cli/cli/__init__.py:155-172` 的 `--config` / `--config-file`);Kimi Code 的
   *    根选项表(`apps/kimi-code/src/cli/commands.ts:30-116`)里**没有** `--config`,连带
   *    `--config-file` 也没有 ⇒ 旧。
   * ## ⇒ 已钉到 Kimi Code(新)。**这不是替 owner 选产品,是让声明追上早就在发生的事实**
   *
   * 上面那条实测已经把「口径」问题变成了「事实」问题:**咕咕的安装按钮今天装出来的就是
   * Kimi Code**。所以把 descriptor 钉过去不改变任何用户拿到的东西,只是让四条互相矛盾的
   * 线索归一;继续骑墙才是在维护一个**没有任何一个用户处在其中**的假想状态。
   *
   * 改了四处(2026-08-24):
   *  · `installCommands` → `https://code.kimi.com/kimi-code/install.sh`(厂商在 legacy 脚本里
   *    自己印的那条)。顺手消掉那 30 秒空等 —— 旧入口要 `read -t 30` 超时才落到新产品,而咕咕的
   *    安装 pty 没有 write 通道,那 30 秒是白等的。
   *  · `updates.releaseSource` → `{ kind:'npm', package:'@moonshot-ai/kimi-code' }`。
   *  · `websiteUrl` / `description` → 新产品的文档站与自述。
   *
   * ### 修掉的 bug:一个**点多少次都清不掉**的「有更新可装」
   *
   * 旧接线 = 装 Kimi Code(`0.38.0`)+ 去 `moonshotai/kimi-cli` 查最新(`1.49.0`,最后一发
   * 2026-07-16)。`agent-update-service.ts:41-46 isNewerVersion` 两边都过 `semver.coerce`,
   * `gt(1.49.0, 0.38.0)` 恒真 ⇒ 永远亮着更新徽标;而 `update: { kind:'package-manager' }` 的
   * 动作是**重跑安装命令**,重跑一次还是 Kimi Code `0.38.0` ⇒ **徽标永远清不掉**。
   * 换 npm 源后 `latest-version-service.ts:109-115` 直接取 `json.version` = `0.38.0`,与本机
   * 装出来的相等,徽标灭。
   * ⚠️ 顺带证伪一个看着更省事的修法:改成 `{ kind:'github', repo:'moonshotai/kimi-code' }`
   *    **当下也能work但是脆的** —— 该仓 tag 是 monorepo 式的 `@moonshot-ai/kimi-code@0.38.0`,
   *    而 github 那一路只做 `tag.replace(/^v/, '')`(`latest-version-service.ts:118-122`),
   *    靠 `semver.coerce` 去猜首个版本样子的子串才蒙对;哪天 tag 里先出现别的数字就静默取错。
   *    npm 是这个产品的规范分发渠道,直接返回干净 `version`,别绕。
   *
   * ### 拿真二进制验过的(装到隔离目录 `KIMI_INSTALL_DIR=… KIMI_NO_MODIFY_PATH=1`,没碰本机 PATH)
   *  · `kimi --version` → `0.38.0`(干净 semver,`VERSION_RE` 与 `coerce` 都取得到)
   *  · `kimi --help` 根选项表里**确实没有** `--config`;直接喂 `--config x=1` →
   *    `error: unknown option '--config'`。阳性对照 `-Z` 同样报 unknown option ⇒ 尺子会响。
   *    ⇒ 上面那条 `injectKimiHooksIntoInlineConfig` 对**新产品是死码**。**但别删** ——
   *    它只在 args 里已经有 `--config` 时才改写,而那只可能来自 `ctx.extraArgs`(用户自己传);
   *    对还留着旧 kimi-cli 的机器它是**真生效的**,删了等于砍掉那批人的 hooks。
   *  · `kimi acp` / `kimi upgrade` 子命令都在(ACP 腿由真二进制而非源码证实)。
   *  · `kimi doctor` 报的配置落点是 `~/.kimi-code/config.toml` + `tui.toml`,与本目录
   *    `hooks.ts` 的 `KIMI_CONFIG_PATH` 一致 ⇒ hooks 那条路本来就是对的,不用动。
   *  · ⚠️ **一条被证伪的猜测,记下来省得下一个人再探**:`resumeWithoutSessionFlag: '-C'` 看着
   *    像错的(help 里写的是 `-c, --continue`,而 commander 短旗标区分大小写),**实测 `-C` 与
   *    `-c` 都被接受、行为一致**(都打「No sessions to continue … starting a fresh session」),
   *    阳性对照 `-Z` 报 unknown option。**不是 bug,别去"修"它。**
   */
  /**
   * **独立 home** —— 咕咕为 kimi 持有自己的一份 `.kimi-code`(机制见
   * `session-core` 的 `capabilities/config-root.ts` 与 `helpers/agent-home.ts`)。
   *
   * ## 为什么这一家需要它
   *
   * kimi 有一批东西**只认 config.toml**、没有任何会话级/命令行载体:
   *  · `[models."…"] support_efforts` —— 决定这个模型的思考控件长成**档位**还是**开关**。
   *    env 里没有这个键;ACP 的 `set_config_option('thinking', …)` 只吃 `on/off`
   *    (给 `high` 直接 `Invalid params: Unknown thinking value`)。
   *  · `[thinking] effort` —— 2026-08-28 实测三条通道里**唯一**能让上游请求体真出现
   *    `"reasoning_effort"` 的那条(实测记录见下方 `applyModelEnv` 的注释块)。
   *  · 咕咕自己的 `[[hooks]]`(`hooks.ts` 的 `KIMI_CONFIG_PATH`)。
   *
   * ❌ 写用户那份 config.toml = **永久改用户的全局配置**(codex 那条「合成 home 毁授权」
   *    的同类动作)。✅ 咕咕写**自己那份**,用户那份一个字节不动。
   *
   * ## 出处(两个事实各自一条)
   *
   *  · 变量名与默认位置同出一处解析式:`MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
   *    `packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:160-166`
   *    `homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`
   *    —— 设了 `KIMI_CODE_HOME`,`~/.kimi-code` **一次都不会再被看**(没有回落)。
   *    已在发行的 npm `@moonshot-ai/kimi-code@0.38.0` 的 `dist/main.mjs` 上复核,两边一致。
   *  · 这个根下装着**全部**身家:登录凭据 `credentials/kimi-code.json`
   *    (`packages/oauth/src/toolkit.ts:127-129`)、会话历史 `sessions/`
   *    (`bootstrapService.ts:45-49`)、`config.toml` / `mcp.json` / `plugins/` /
   *    `skills/` / `agents/` / `logs/`。⇒ **整份复制**才是对的,复制一个 config.toml
   *    等于给用户一个没登录、没历史、没 skill 的 kimi。
   */
  configRoot: {
    envVar: KIMI_HOME_ENV,
    userPath: '.kimi-code',
    // ⚠️ 全仓**唯一**还在托管侧的家,也因此是唯一整份复制用户配置根的家(托管 ⇒ 必复制,
    //    owner 2026-09-03:「托管但不复制」= 合成目录,严格禁止)。理由是实测的:档位
    //    (support_efforts)只认它自己 `config.toml` 里的值,env 注入的模型在 kimi 内部是
    //    `__kimi_env_model__`,挂不上去(#4834 四格矩阵 dd0463a634)。实测副本 178 MB。
    evidence:
      'MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6 '
      + 'packages/agent-core-v2/src/app/bootstrap/bootstrap.ts:160-166 '
      + "`homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`;"
      + '已在 npm @moonshot-ai/kimi-code@0.38.0 的 dist/main.mjs 复核一致;取证 2026-08-28',
    // 分家时**不**带走的东西。默认全带 —— 只减去「引擎自己会重新长出来的」与
    // 「咕咕自己会写的」。判据是**能不能重新长出来**,❌ 不是体积大小。
    //
    // ⚠️ 先做过反过来的版本(挑要带哪些),被判否:漏挑一条配置 = 静默丢用户设置,
    //    而引擎的配置面随上游版本增删,白名单结构上跟不上。实证就是那一版本身 ——
    //    按 mac1 那台的目录布局挑,漏了 `skills/`、`AGENTS.md`、`SYSTEM.md`、`agents/`
    //    四条(它们只在用户用过那个功能后才存在,那台一个都没有)。理由钉在
    //    `AgentConfigRoot.carryExclusions` 抬头。
    //
    // 布局实测:mac1 2026-09-04,`~/.kimi-code` 共 262 条 / 349 MB;排掉下面这些之后约 3 MB。
    carryExclusions: [
      {
        path: 'bin',
        evidence:
          'mac1 2026-09-04 实测 346 MB,里面是 `kimi`(172 MB,引擎本体)与 `fd`。'
          + '那是**程序**不是配置:换台机器/换个版本引擎自己会重新放,带过来还会带错架构。',
      },
      {
        path: 'cache',
        evidence:
          'mac1 2026-09-04 实测 142 个条目 / 500 KB,内容形如 `cache/query-store/shard-*/`。'
          + '派生索引,咕咕这份自己会重新长;带过来还可能把用户那边的陈旧分片一起继承。',
      },
      {
        path: 'logs',
        evidence: 'mac1 2026-09-04 实测存在;运行日志,只描述用户那份的历史,对咕咕这份没有读者。',
      },
      {
        path: 'telemetry',
        evidence: 'mac1 2026-09-04 实测存在(空目录);上报缓冲,引擎自己会重建。',
      },
      {
        path: 'updates',
        evidence: 'mac1 2026-09-04 实测存在;自更新的下载/记账,指向用户那份的安装,咕咕这份重新长即可。',
      },
      {
        path: 'mcp.json',
        evidence:
          '这一条不是「派生物」,是**咕咕自己会写它**:见本文件「终端腿的 MCP」抬头 ——'
          + '每会话整份重写(artifact,不是 merge),里面只有咕咕的 server。带用户那份过来只会被'
          + '覆盖,而覆盖之前那个窗口里咕咕的 home 挂着用户的 server(连不通,且带着他的令牌)。',
      },
    ],
    seedFiles: [
      {
        // 「这份 home 里不必再问从 kimi-cli 迁移」。
        //
        // 为什么要种:kimi 按**目标目录**记账(用户真 home 的
        // `~/.kimi/.migrated-to-kimi-code` 里写着 `target_paths: ["~/.kimi-code"]`),
        // 而咕咕这份配置根是个新目标 ⇒ 它会对着咕咕这份重新问一遍「Found an existing
        // kimi-cli installation … Migrate this data to kimi-code?」。
        //
        // ⚠️ 那个询问的默认项停在「Migrate now」,而选下去会拿用户的**旧 kimi-cli 配置**
        //    盖掉咕咕刚写好的 `config.toml`(平台模型、`[providers.gugu]`、思考档位全在里面)——
        //    一个默认答案就是错的问题,不该抛给用户。owner 2026-08-28 真撞上并来问了。
        path: '.skip-migration-from-kimi-cli',
        content: '',
        evidence:
          '实测(2026-08-28,kimi-code 0.39.0,咕咕独立 home):在那个询问里选「Never ask again」'
          + '之后,**咕咕这份**配置根里多出一个零字节的 `.skip-migration-from-kimi-cli`,'
          + '而用户真 home 的 `~/.kimi/.migrated-to-kimi-code` md5 与 mtime 一字未动 ⇒ '
          + '这个状态记在目标 home 里,且存在性本身就是信号(所以内容为空)。'
          + '官方迁移文档只写「首次运行会检查 ~/.kimi/」,没有记这个机制。',
      },
    ],
    firstRunState: [
      {
        relPath: ({ cwd }: { cwd: string }) => kimiWorkspaceTrustPath(cwd),
        format: 'json',
        entries: ({ cwd }: { cwd: string }) => ({ root: cwd, trustedAt: Date.now() }),
        evidence:
          'Kimi Code 0.39.0 runtime: /tmp/kimi-trust-home2.kMuQt6/workspace-trust/'
          + 'wd_kimi-trust-cwd2.2t1sv9_6ba39f839fcc contains '
          + '{"root":"/private/tmp/kimi-trust-cwd2.2t1SV9","trustedAt":1788330918823}; '
          + 'dist/main.mjs writeWorkspaceTrust (byte 9017000) calls docs.set("workspace-trust", '
          + 'trustKey(root), {root, trustedAt}); encodeWorkDirKey (byte 8539435) uses wd_ + '
          + 'lowercase basename slug (max 40) + sha256(normalized cwd).slice(0,12).',
      },
    ],
  },
} satisfies SessionBundleDescriptor;

/**
 * 咕咕自己那份 kimi 配置根里的一个文件。
 *
 * 布局只此一处解析(`agentHomeSegments`)—— ❌ 别在别处手写 `agent-homes/kimi/...`:
 * 两处各写一遍,改了一处就是「hook 写 A、会话读 B」,而两边都不报错。
 */
function guguKimiConfigPath(bundle: SessionCapabilityBundle, basename: string): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) {
    throw new Error('Kimi session adapter requires bundle.env.GUGU_HOME');
  }
  return join(
    guguHome,
    ...agentHomeSegments(KIMI_PROVIDER_ID, kimiSessionBundleDescriptor.configRoot.userPath),
    basename
  );
}

/**
 * 终端腿的 MCP —— 把这一次会话的咕咕 server 整份写进
 * `<咕咕的 kimi 配置根>/mcp.json`(理由与「为什么现在能写了」见 `KIMI_MCP_CONFIG_BASENAME`)。
 *
 * ⚠️ 只在**终端腿**产出:协议腿的载体是 `session/new` 的 `mcpServers`,两条都产出等于
 * 同一批 server 注册两遍。
 * ⚠️ 令牌落在 0600 的文件里 —— 与 env 同级(只有本进程够得着),❌ 不进 argv(进程表人人可读)。
 */
function mcpConfigArtifact(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): GeneratedArtifact | null {
  if (ctx.surface !== 'tui') return null;
  const servers: Record<string, unknown> = {};
  for (const server of bundle.mcpServers) {
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, 'Kimi');
      servers[server.name] = sessionMcpStdioConfig(server);
      continue;
    }
    const authorization = sessionMcpAuthorization(server, bundle.env, 'Kimi');
    servers[server.name] = {
      transport: 'http',
      url: server.url,
      ...(authorization ? { headers: { Authorization: authorization } } : {}),
    };
  }
  // 一个 server 都没有时**不写文件**:写一份空的 `{"mcpServers":{}}` 会把咕咕这份配置根里
  // 上一次会话留下的那份**清空**,而它可能正被另一条会话读着。
  if (Object.keys(servers).length === 0) return null;
  return {
    path: guguKimiConfigPath(bundle, KIMI_MCP_CONFIG_BASENAME),
    content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    mode: 0o600 as const,
  };
}

/**
 * kimi **支持的思考档位** —— 出处是官方文档 `configuration/config-files.html` 的
 * `[models.*] support_efforts`(「Thinking intensity levels」)与 `[thinking] effort`,
 * 以及 env 文档里 `KIMI_MODEL_THINKING_EFFORT` 的取值 `low/medium/high/xhigh/max`。
 *
 * ⚠️ 这是**引擎侧**的能力,不是某个上游模型的能力 —— kimi 把它翻译成
 * `reasoning_effort` 发给 openai 形状的上游,上游认不认是上游的事。
 * ❌ 别按上游模型去裁这张表:那会让同一个引擎在不同模型上长出不同的控件。
 */
const KIMI_SUPPORT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 咕咕在 kimi 配置里用的 provider 名 —— 与用户自己的 provider 隔开,❌ 别叫通用名字。 */
const GUGU_PROVIDER_KEY = 'gugu';

/**
 * 把平台模型写进**咕咕自己那份** `config.toml`(独立 home)。
 *
 * ## 为什么不再用 `KIMI_MODEL_*` env —— 实测定论,❌ 别改回去
 *
 * 2026-08-28 在 0.39.0 上用假上游 + 真 `kimi acp` 跑的四格矩阵(config/env × 有无
 * `support_efforts`),读数是:
 *
 * | 模型怎么进来 | support_efforts | ACP 报的 thinking 选项      | 上游 body            |
 * |---|---|---|---|
 * | config.toml | 无   | `off/on` 两档                | 无 reasoning_effort   |
 * | config.toml | **有** | **off/low/medium/high/xhigh/max** | **`"reasoning_effort":"high"`** |
 * | env 注入    | 无   | `off/on`                     | 无                    |
 * | env 注入    | **有** | `off/on`(**没变**)         | **无**                |
 *
 * 最后一格是关键:env 注入的模型在 kimi 内部的 id 是 **`__kimi_env_model__`**,
 * 而且它就是 `currentValue`。config.toml 里的 `[models."<真名>"]` 与它是**两个条目**,
 * 挂上去的 `support_efforts` 到不了它头上;按 `[models."__kimi_env_model__"]` 去挂也无效
 * (实测:仍是 `off/on`,`set_config_option('thinking','low')` 被拒
 *  `Invalid params: Unknown thinking value: low`)。
 * ⇒ 想要档位,模型就**必须**整份写进 config.toml。而写 config.toml 的前提是独立 home
 *   —— 写用户那份 = 永久改用户的全局配置,那是 codex「合成 home 毁授权」的同类动作。
 *
 * ## 每次会话的档位不写这里,走 ACP
 *
 * 实测同一条会话里 `set_config_option({configId:'thinking', value})` 依次设
 * `low`/`max`/`off`,下一轮上游 body 分别是 `"low"`/`"max"`/**没有该字段**,
 * 而 `config.toml` **一个字节没变**(`configChanged: false`)。
 * ⇒ 并发会话各自选档不会互相踩;咕咕那条通道(`session-manager.ts` 的 `applyInitialEffort`)
 *   本来就通着。这里写的 `default_effort` 只是**初值**。
 *
 * ## 登记**全部**平台模型,不只这一次选的那个
 *
 * 会话内换模型走 ACP 的 `model` 选项,不该回头重写配置文件。全登记之后,配置里
 * 唯一随会话变的只剩 `default_model` 与凭据 —— 而它们对同一个用户是同一份。
 */
/**
 * 终端腿的编辑器偏好:关掉 kimi 的「粘贴突发」判定,否则注入的首句**永远发不出去**。
 *
 * ## 机制(Kimi Code 0.39.1 与 0.40.1 逐字相同,`dist/main.mjs` 的 `PasteBurst`)
 *
 *  · 编辑器给每个可打印字符记时:相邻字符间隔 ≤ `PASTE_BURST_CHAR_INTERVAL_MS = 8`
 *    的连续 ≥ `PASTE_BURST_MIN_CHARS = 8` 个,就判成一次「非括号粘贴」,并把
 *    `enterSuppressUntil` 推到最后一个字符之后 `PASTE_ENTER_SUPPRESS_WINDOW_MS = 120`。
 *  · 在这个窗口里收到回车(`tui.input.submit`),`shouldInsertNewlineInsteadOfSubmit`
 *    为真 ⇒ **插入换行而不是提交**,并再把窗口续 120ms。
 *  · 注入器逐字符 `pty.write`(#4794,为了绕开整段写入被吞)恰好制造了这条判定要抓的形状:
 *    字符全在同一个事件循环 tick 里到达,间隔 0ms;随后 `submitDelayMs = 50` 的 `\r`
 *    落在 120ms 窗口内 ⇒ 变成换行。真机症状与之逐字吻合:字都在输入框里、多一个空行、
 *    `Session:` 空、`context: 0%`;几分钟后人手敲一次回车立刻提交(3/3)。
 *  · 「有时能成」不是反证:判定用的是 kimi **处理**每个键的 `Date.now()`,不是 pty 写入时刻。
 *    启动期事件循环忙,字符与回车被拆进不同 tick、恰好隔开 >120ms 时就成功了 ——
 *    这正是 2026-09-03 真机 4/26 那种「同一份代码忽好忽坏」的来源。
 *
 * ## 为什么用配置开关,而不是把 `submitDelayMs` 调到 >120
 *
 *  调延时是在猜 kimi 的处理时刻,而上面已经证明处理时刻与写入时刻可以差几百毫秒
 *  (0/550/1450/3000ms 四次补发回车实测 0/3)。kimi 自己给了确定性的口子:
 *  `tui.toml` 的 `disable_paste_burst = true`(`TuiConfigSchema`,0.39.1 起就有)。
 *  这条判定只是给**不支持括号粘贴的终端**准备的兜底;咕咕的终端是 xterm.js,kimi 启动时
 *  就开了 `\x1b[?2004h`,用户真粘贴走括号序列,不经过这条判定 ⇒ 关掉它对用户零损失。
 *
 * ## 落点
 *
 *  写的是咕咕**自己那份**独立 home 里的 `tui.toml`(与 `modelConfigOverlay` 同一个配置根),
 *  用户的 `~/.kimi-code/tui.toml` 一个字节不动。`conflict: 'gugu-owns'`:独立 home 是从
 *  用户那份整份复制来的,里面已经有 `disable_paste_burst = false`,咕咕每次会话都要把它
 *  改成 true,这是正常覆盖不是冲突。只在终端腿产出:协议腿(`kimi acp`)没有编辑器。
 */
function tuiEditorOverlay(bundle: SessionCapabilityBundle): TomlOverlay {
  const tuiFile = guguKimiConfigPath(bundle, 'tui.toml');
  return {
    sourcePath: tuiFile,
    path: tuiFile,
    conflict: 'gugu-owns',
    mode: 0o600,
    patch: { disable_paste_burst: true },
  };
}

function modelConfigOverlay(bundle: SessionCapabilityBundle): TomlOverlay | null {
  const model = bundle.model;
  if (!model) return null;
  if (model.dialect !== 'kimi-model-env') {
    throw new Error(`Kimi session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return null;
  const selected = model.model?.trim();
  if (!selected) return null;

  const configFile = guguKimiConfigPath(bundle, 'config.toml');

  const catalog = model.platformModels?.length
    ? model.platformModels.map((entry) => entry.id)
    : [selected];
  const ids = catalog.includes(selected) ? catalog : [...catalog, selected];

  const models: Record<string, unknown> = {};
  for (const id of ids) {
    models[id] = {
      provider: GUGU_PROVIDER_KEY,
      model: id,
      // ❌ 别省 max_context_size:它是必填,缺了整条 `[models.*]` 会被拒。
      max_context_size:
        model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 262144,
      capabilities: ['thinking', 'tool_use'],
      support_efforts: [...KIMI_SUPPORT_EFFORTS],
      ...(model.reasoningEffort && (KIMI_SUPPORT_EFFORTS as readonly string[]).includes(model.reasoningEffort)
        ? { default_effort: model.reasoningEffort }
        : {}),
    };
  }

  return {
    sourcePath: configFile,
    path: configFile,
    // 「读写咕咕自己那份」⇒ 补丁赢。第二次会话把 default_model / 凭据改成新值是正常的。
    conflict: 'gugu-owns',
    mode: 0o600,
    patch: {
      default_model: selected,
      providers: {
        [GUGU_PROVIDER_KEY]: {
          // ❌ 别省 type:缺省是 `kimi`(打 Moonshot 官方端点),base_url 会被无视,
          //    请求会打去厂商那边而不是咕咕的网关。
          type: 'openai',
          base_url: platform.baseUrl,
          api_key: platform.apiKey,
        },
      },
      models,
      // owner 定:咕咕这边**默认开着**思考。档位由 support_efforts + 会话级通道决定。
      thinking: { enabled: true },
    },
  };
}

/**
 * kimi 的 agent 档名 —— 解析器要求 kebab-case（`AGENT_NAME_PATTERN`），`gugu` 合规。
 *
 * ⚠️ **不叫 `agent`**：那是 kimi 内建默认档的名字（`DEFAULT_AGENT_PROFILE_NAME`）。
 *    `--agent-file` 的 source 是 `explicit`（优先级 40，全场最高）且 `agentProfileFromFile`
 *    对 explicit 自动置 `override: true`，所以**不需要**靠重名去顶掉默认档 —— 重名只会让
 *    读日志的人分不清顶掉的是谁。
 */
const GUGU_AGENT_NAME = 'gugu';

/**
 * 这一段是 kimi 的 **agent 档**格式契约，逐条取自 `@moonshot-ai/kimi-code@0.39.0`
 * 的 `dist/main.mjs`（`parseAgentFileText`）。写错不是降级，是**启动就致命失败** ——
 * `resolveAgentProfileSelection` 明写「the file is parsed here (fatal on error) so a bad
 * file fails before any session work」。所以这几条都是硬要求：
 *
 *  · `description` **必填且非空**（`requiredNonEmptyString(frontmatter["description"], …)`）；
 *  · 正文 **必填且非空**（`parsed.body.trim()` 为空即抛）；
 *  · `name` 缺省会从文件名推导，但必须过 `AGENT_NAME_PATTERN`（kebab-case）；
 *  · `${base_prompt}` 会被替换成 kimi **内建默认档的系统提示词**
 *    （`agentProfileFromFile(definition, defaultTools, basePrompt)` 的第三个参数）。
 *
 * ⚠️⚠️ `${base_prompt}` **必须**留着：不写它就是把 kimi 自己的系统提示词整个**换掉**，
 *    而咕咕只想在后面补一段身份自述。这是「追加」与「替换」的分界，删掉这一行 =
 *    悄悄把 kimi 变成一个不知道自己会什么的 agent。
 */
function renderKimiAgentFile(prompt: string): string {
  return [
    '---',
    `name: ${GUGU_AGENT_NAME}`,
    'description: Gugu platform session profile.',
    '---',
    '${base_prompt}',
    '',
    prompt,
    '',
  ].join('\n');
}

const promptKeys = ['platform', 'identity'] as const;

/**
 * ⚠️ 只取 `platform` 与 `identity`，**不取 `threadBootstrap`**：agent 档在**会话创建时**
 *    读一次，之后 kimi 把它快照进会话记录、续跑时原样还原（0.39.0 的
 *    `agentProfileCatalog` + `restoreSnapshot`）。而 `threadBootstrap` 是「该 thread 最近
 *    那几十条历史」，每条消息都在变 —— 放进一份只读一次的档里，等于把一份**会一直过期**
 *    的历史钉死在系统提示词里。与 codex `@@@app-server` 那条同一个道理。
 */
function renderPromptBlocks(blocks: SessionPromptBlocks): string {
  return (blocks.platform ?? '') + (blocks.identity ?? '');
}

type AgentFileDelivery = {
  artifact: GeneratedArtifact;
  path: string;
  delivered: (typeof promptKeys)[number][];
};

/**
 * 终端腿的身份自述载体 —— 咕咕把一份 agent 档写进**自己的**目录，再用 `--agent-file`
 * 把 kimi 指过去。
 *
 * 为什么是这条路（三条备选都验死了，出处见 `promptBlocksMissingCarrier`）：
 *  · 用户的 `~/.kimi-code/SYSTEM.md` —— 那是**用户的**文件，behavior
 *    `agent-config-boundary`「任何一个文件都当作用户已经在用」直接判否；
 *  · 合成 `KIMI_CODE_HOME` —— 同一条 behavior 的「默认不为咕咕另造一份配置根」判否，
 *    理由是它两种形态都堵（用完就扔 = 用户在咕咕里做的一切归零；长期保留 = N+1 份
 *    互不相干且各自漂移的状态，而格式由上游定义）；
 *  · 项目里的 agent 档 —— owner 明令咕咕不往用户的项目目录里留文件。
 *
 * 这条路一条用户文件都不碰：档落在 `GUGU_HOME` 下（宿主的 artifact 落点本来就被钳在
 * `within(guguHome, …)`），路径是咕咕现生成的 uuid —— 「用户已经在用它」不可能成立。
 *
 * ⚠️ 拿不到 `GUGU_HOME` 就抛：那意味着调用方没给会话根，把档写到别处 = 在用户机器上留残留。
 * ⚠️ 一个块都没有时返回 `null` —— **一个字都不发**。写个空档再把 `--agent-file` 指过去，
 *    会因为「正文为空」被 kimi 判成非法档，启动直接失败。
 */
function agentFileDelivery(bundle: SessionCapabilityBundle): AgentFileDelivery | null {
  const delivered = promptKeys.filter((key) => Boolean(bundle.promptBlocks[key]));
  const value = renderPromptBlocks(bundle.promptBlocks);
  if (!value) return null;
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) {
    throw new Error('Kimi session adapter requires bundle.env.GUGU_HOME');
  }
  const path = join(
    guguHome,
    'runtime-sessions',
    // ⚠️ 目录名**故意不叫** `kimi-capability-runs` —— 那个名字是「合成 home」的签名，
    // 用例里有一条 `expect(JSON.stringify(result)).not.toContain('kimi-capability-runs')`
    // 专门钉它别复活。撞名会让那条守卫从此恒假，等于亲手把它拆了。
    'kimi-agent-files',
    randomUUID(),
    'gugu-session.md'
  );
  return {
    // ⚠️ 0600：这段自述里有这个 agent 的咕咕身份。
    artifact: { path, content: renderKimiAgentFile(value), mode: 0o600 as const },
    path,
    delivered,
  };
}

/**
 * `--agent-file` 只在**新建**会话时递得进去。
 *
 * 不是保守，是 kimi 的硬冲突：`options.ts` 明写
 * 「Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at
 * session creation and the bound agent is restored automatically on resume.」
 * 而咕咕的 kimi 终端腿续跑正是发 `-S <id>` / `-C`（`impl/kimi/index.ts` 的
 * `resumeFlag:'-S'` / `resumeWithoutSessionFlag:'-C'`）—— 在续跑时再发一次
 * `--agent-file`，**kimi 会直接拒绝启动**。
 *
 * 而续跑时不发**不是漏投递**：绑定在建会话时就被快照进会话记录
 * （0.39.0 的 session metadata 存 `agentProfileCatalog`，续跑走 `restoreSnapshot`
 * 读回来，正文也在里面），所以续跑起来的仍是同一个身份。
 *
 * ⚠️ fork 这条腿在 kimi 上**不存在**：`buildKimiCommand` 没配 `forkCommand`/`forkFlag`，
 *    `buildStandardCommand` 走到 fork 分支会直接抛「fork requested but no verified fork
 *    adapter is configured」。所以这里只判 `fresh`，不是漏了 `fork`。
 *
 * ⚠️⚠️ **光判 `lifecycle` 是不够的**:`lifecycle` 由 `resumeProviderSessionId` 推出（`main.ts`），
 *    而 argv 的续跑分支看的是 `isResuming`（`buildStandardCommand`）。两者在「要续跑、但引擎自己的
 *    session id 还没拿到」那一格上可能分叉:没声明 `sessions.resumeNeedsProviderId` 的家 `isResuming`
 *    原样透传、argv 落到 `resumeWithoutSessionFlag`,而 `lifecycle` 仍是 `'fresh'`。
 *    kimi 今天**声明了**它(./index.ts,2026-08-28 正是为这一格加的):没有原生 id 时宿主把 `isResuming`
 *    压成 false,argv 不发 `-C`,这一格对 kimi 不再出现。这里仍同时判 `ctx.isResuming` —— 那一发
 *    `--agent-file -C` 不是降级，是 kimi **拒绝启动**;它是宿主从会话页那侧原样带过来的真值，
 *    ❌ 别从 `lifecycle` 反推。
 */
function deliversAgentFile(ctx: SessionMaterializationContext): boolean {
  return ctx.surface === 'tui' && ctx.lifecycle === 'fresh' && ctx.isResuming !== true;
}

/**
 * Kimi Code 的物化 —— 在通用 ACP 物化之上只加**模型**一样。
 *
 * MCP 那一维由通用物化直接兑现（`units.mcp.channel === 'acp-session'`，形状恰好同形）。
 *
 * ❌ 这里**不写** `KIMI_CODE_HOME`：会话声明了就由通用物化原样透传，没声明就不存在 ——
 *    咕咕不替用户改他的家。理由与逐条出处见 `KIMI_HOME_ENV` 抬头。
 * ❌ 也不再落 `SYSTEM.md`：宿主的 artifact 落点被钳在 `within(guguHome, …)`
 *    （`electron/session-materialization.ts`），而 kimi 只从 `<KIMI_CODE_HOME>/SYSTEM.md` 读 ——
 *    不合成 home 就没有一条它会去读的路径。写一份没人读的文件 = 假投递。
 */
export function materializeKimiSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle,
): SessionMaterialization {
  // 终端腿的 MCP 由本文件自己物化(写咕咕那份 mcp.json,见 `mcpConfigArtifact`)——
  // 通用物化器只会填 `acp.mcpServers`,那是协议腿的载体。
  const base = materializeAcpSessionBundle('kimi', kimiSessionBundleDescriptor, ctx, bundle, {
    mcpMaterializedByProvider: ctx.surface === 'tui',
  });

  const env: Record<string, string> = { ...base.env };
  // 模型不再走 `KIMI_MODEL_*` env —— 那条路拿不到档位(实测四格矩阵见 `modelConfigOverlay`)。
  const modelOverlay = modelConfigOverlay(bundle);
  // 终端腿的编辑器偏好:关掉粘贴突发判定,否则注入的首句只会变成一个换行(见 `tuiEditorOverlay`)。
  const editorOverlay = ctx.surface === 'tui' ? tuiEditorOverlay(bundle) : null;
  // 终端腿的 MCP:整份写进咕咕自己那份 mcp.json(协议腿走 `session/new`,不产出这个)。
  const mcpArtifact = mcpConfigArtifact(ctx, bundle);

  // 终端腿的身份自述:写一份 agent 档到咕咕自己的目录 + `--agent-file` 指过去。
  // ⚠️ 只在 `tui` + `fresh` 上产出 —— 见 `deliversAgentFile` 抬头,那两个条件
  //    各自都是硬约束:`kimi acp` 根本不收这个 flag(只有 `--login`/`--region`),
  //    续跑又必然带 `-S`/`-C`,与它互斥到**拒绝启动**。
  const agentFile = deliversAgentFile(ctx) ? agentFileDelivery(bundle) : null;

  // 协议腿的身份自述:同一段话,走用户级载体(③)。
  // ⚠️ 与终端腿那条**互斥**:一条腿一种载体,`ctx.surface` 决定走哪个。
  //    两条都产出 = 同一段话在同一条会话里说两遍。
  const promptValue = ctx.surface === 'acp' ? renderPromptBlocks(bundle.promptBlocks) : '';
  const sessionContextPrompt = promptValue
    ? {
        value: promptValue,
        delivered: promptKeys.filter((key) => Boolean(bundle.promptBlocks[key])),
        carrier: 'session-context' as const,
      }
    : undefined;

  return {
    ...base,
    env,
    ...(sessionContextPrompt ? { prompt: sessionContextPrompt } : {}),
    argsAppend: agentFile
      ? [...base.argsAppend, '--agent-file', agentFile.path]
      : base.argsAppend,
    artifacts: [
      ...base.artifacts,
      ...(agentFile ? [agentFile.artifact] : []),
      ...(mcpArtifact ? [mcpArtifact] : []),
    ],
    // ⚠️ 顺序有意:模型那条放最后 —— 既有用例用 `.at(-1)` 拿它当读数锚。
    tomlOverlays: [
      ...(base.tomlOverlays ?? []),
      ...(editorOverlay ? [editorOverlay] : []),
      ...(modelOverlay ? [modelOverlay] : []),
    ],
    report: {
      ...base.report,
      units: {
        ...base.report.units,
        model: modelOverlay
          ? { status: 'loaded' as const }
          : {
              status: 'degraded' as const,
              reason: { code: 'unverified' as const, reason: 'No model was declared.' },
            },
        // ⚠️ 这一格**必须**在这里按「这一次到底发没发」报,不能沿用通用物化按 descriptor
        //    直接报 loaded:descriptor 说的是「这条腿有这个通道」,而续跑那一次是真的
        //    一个字都没发(靠 kimi 自己从会话记录还原)。照 descriptor 报 loaded,
        //    「没投递」就会以「已加载」的形态活下去 —— 正是判据判不了假的那种形状。
        promptBlocks: agentFile || sessionContextPrompt
          ? { status: 'loaded' as const }
          : promptBlocksReport(ctx),
      },
    },
  };
}

/**
 * 没真发出去时这一格该报什么 —— 三种情况**理由不同**,❌ 别合成一句。
 */
function promptBlocksReport(ctx: SessionMaterializationContext) {
  if (ctx.surface !== 'tui') {
    // ⚠️ 走到这里只剩一种可能:**一个提示块都没声明**。载体本身是好的(③ 已接通),
    //    所以理由❌ 不能再写「没有载体」—— 那会让一次「没东西可发」长得像一格能力欠账,
    //    而能力欠账是要有人去补的。
    return {
      status: 'degraded' as const,
      reason: { code: 'unverified' as const, reason: 'No prompt blocks were declared.' },
    };
  }
  if (ctx.lifecycle !== 'fresh' || ctx.isResuming === true) {
    // 续跑/分叉:**不是缺陷**。绑定在建会话时已快照进 kimi 自己的会话记录,
    // 这一次不发才是对的(发了会被 kimi 拒绝启动)。所以如实记成「这一次没发,原因是它
    // 已经在那儿了」,而不是 loaded(没发却报发了)也不是缺载体(载体好好的)。
    return {
      status: 'degraded' as const,
      reason: {
        code: 'unverified' as const,
        reason:
          'Resume does not re-send --agent-file: kimi binds the agent at session creation and '
          + 'restores it from the session record (agentProfileCatalog snapshot). Re-sending it '
          + 'alongside -S/-C is rejected by kimi at startup.',
      },
    };
  }
  return {
    status: 'degraded' as const,
    reason: { code: 'unverified' as const, reason: 'No prompt blocks were declared.' },
  };
}
