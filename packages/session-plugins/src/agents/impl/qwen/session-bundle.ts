import { harnessPlatform } from './platform';
import {
  dirname,
  join,
} from 'node:path';
import { geminiFamilyHttpMcpEntry, nestedHooksObject } from '@gugu/session-core/agents/plugins/helpers';
import type {
  Degradation,
  JsonOverlay,
  NativeHome,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionMcpServer,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';
import { qwenHookSpecs } from './hooks';
import { sessionContextPrompt, sessionPromptText, sessionRunHome } from '../../helpers/session-bundle';

const VERSION = '0.21.10';
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Qwen Code v${VERSION} ${unit} delivery has not been verified from its published source.`,
});
const unverifiedExtension = unverified('extension');
const noPromptBlocks: Degradation = {
  code: 'unverified',
  reason: 'No prompt blocks were declared.',
};

export const qwenSessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: { envVar: 'QWEN_HOME', userPath: '.qwen', evidence: 'qwen-code:QWEN_HOME 挪走用户层配置,默认 ~/.qwen(订阅读数同一条,见 ./subscription.ts)' } satisfies NativeHome,
  platform: harnessPlatform,
  shellEnv: {
    passThrough: [
      'BAILIAN_CODING_PLAN_API_KEY',
      'QWEN_CODE_SUPPRESS_YOLO_WARNING',
      'QWEN_DEFAULT_AUTH_TYPE',
      'QWEN_HOME',
      'QWEN_MODEL',
      'QWEN_RUNTIME_DIR',
      'QWEN_SANDBOX',
    ],
  },
  // 平台令牌只在子进程环境里(`OPENAI_API_KEY`,两条腿同一个 `applyModelEnv`);终端腿那份 system settings
  // 只写 `envKey` 的名字(见 `platformModelPatch`)。进程起来后换不了值 ⇒ 到期按原形态重开。
  credentialLifecycle: {
    'acp': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
    'tui': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  /**
   * 关自更新(#6186)。qwen 的更新检查只在交互界面启动后跑(ACP 腿不跑),门是两个条件的与:
   * settings `general.enableAutoUpdate !== false` **且** env `QWEN_CODE_SKIP_UPDATE_CHECK_ONCE !== 'true'`。
   * 走 env 这一半:settings 那一半只能写进 qwen 读的某一层 settings 文件,用户那份 `~/.qwen/settings.json`
   * 是红线(#6178),而 env 两条腿都够得着、不依赖任何文件是否生成。这个 env 是 qwen 自己
   * 在更新后重启时设的同一个开关,也在它递进沙箱的白名单里。不关时它会把新版装进 `~/.qwen/updates`
   * 并切换 `active.json`,同机后起的会话就换了版本(#6186 读数:0.24.2 与 0.24.4 并存)。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true' },
    evidence:
      'QwenLM/qwen-code@9674d6efdc8a (v0.24.4) packages/cli/src/startup/startup-prefetch.ts:156-157'
      + ' 更新检查的门;packages/cli/src/ui/handleAutoUpdate.ts 的安装动作只在这道门之后。取证 2026-09-23',
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    // 这条腿开着，判据是 `e2e/agent/qwen-acp-delivery-4530.spec.ts`(#6270 已删) 的产品闭环。
    //
    // ⚠️ 此前这里写着「exact-head YATU returned [NO_REPLY]」并据此关闭。那次读数**不成立**：
    //    `[NO_REPLY]` 是 `<gugu_silence>` 自己教给 agent 的沉默哨兵，模型说出它恰恰证明消息**到了**
    //    （qwen 自己的会话文件里逐字记着那次的暗号）。把同一段 11k 字正文原样重放 5 次，
    //    `[NO_REPLY]` 复现 0/5，其中 4 轮还调了工具 —— 那是一次抽样，不是这条腿的性质。
    //
    // 第三轴 injection（spec session-injection，next-tool-call 铺开第一批 2026-09-01）：
    // 忙时第二条**标准** `session/prompt` 受理，turn-1 RPC 报 `stopReason=cancelled`（spec「假 cancelled 移交守卫」
    // 覆盖的那一形），暗号在首个 tool-result 请求（user 位）进模型 —— busy 3/3 + idle 阳控 1/1（qwen 0.22.3，
    // 本地假端点，`craft/drainMidTurnQueue` 客户端 hook 咕咕未实现、driver 回 -32601 也不影响暗号到达）。
    // 声明一落，内核 steer 下水道即在忙时直发同一条标准 `session/prompt`（`steerIfBusy`），零内核 diff。
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence:
          'shuxueshuxue/gugu-base@27acb72ad4b4ab0e59aa4646acde2d534e9b75d0 evidence/2026-09-01-nextcall-batch1-acp-injection（qwen ACP busy 3/3 next-tool-call + idle 1/1；另见 #4472 comment-5464601764 / #4482）',
        // 忙时 turn-1 主 RPC 报 `stopReason=cancelled`(假 cancelled) —— 由 cell 的移交守卫覆盖(工具往返
        // 照常完成、暗号照常在 tool 边界进模型、turn 不落 cancelled 终态),对用户透明。记进机器可见的
        // deviations 让读声明的人知道这一格靠那道守卫,而非把它藏在注释里(comments 过不了 zod parse)。
        deviations:
          '忙时 turn-1 主 RPC 报 stopReason=cancelled(假 cancelled),由 cell 移交守卫覆盖 —— 工具往返照常完成、暗号照常在 tool 边界进模型、turn 不落 cancelled 终态,对用户透明',
      },
    },
    'tui': {
      identity: 'addressable',
      messageTransport: 'local-session',
      promptInput: {
        multiline: 'plain',
        evidence:
          'shuxueshuxue/gugu-base@e3140a8 evidence/2026-09-06-qwen-paste/step-7 (Qwen Code 0.23.0 complete host write still exposed [Pasted Content] placeholder)',
      },
    },
  },
  units: {
    // MCP —— 两条腿都走 run-scoped 的系统级 settings 副本(`QWEN_CODE_SYSTEM_SETTINGS_PATH`),
    // ❌ 不碰用户的 `~/.qwen/settings.json`。
    //
    // ⚠️ **ACP 腿为什么不走 `session/new`(#6192)**:qwen 0.24.x 把 MCP 工具**延迟装载** ——
    //    不上模型的工具表,只能 `tool_search` 找、经 `tool_call({name, arguments})` 桥调。会话包对
    //    咕咕那台 server 声明了 `alwaysLoad`,qwen 的原生开关是 server 条目上的 `alwaysLoadTools`,
    //    而 ACP 协议的 McpServer 形状里**没有这个字段**,`session/new` 那台又按名整条盖掉 settings
    //    里同名那台 ⇒ 走协议这条路 `alwaysLoad` 必然静默丢失。聊天页私聊因此永远回不了:模型按裸名
    //    `select:message_reply` 落空,再经桥时把参数多包一层,三次后 qwen `LOOP_DETECTED`。
    //    实测(mac1,qwen 0.24.4,`qwen --acp` + 假 OpenAI 端点抓**首个上行请求的 tools**,
    //    stdio 探针 spawn 即落标记):session/new 递 → spawn 1、探针工具**不在表上**;
    //    settings 副本 + `alwaysLoadTools` → spawn 1、`mcp__probe__ping` **在表上**;
    //    阴控不给 server → spawn 0、不在表上。`-p` 腿同一组三格同形。
    //
    // ⚠️ 这一格 2026-09-03 之前是 `user-config`:spawn 前由一个 apply-only writer 把咕咕的条目
    //    合并进**用户自己的**配置文件。那正是 owner 划的红线 —— MCP 属于会影响 agent 上下文
    //    工程的注入,不该落进它的全局配置。
    //
    // ⚠️ **为什么不用 `--mcp-config`(即 copilot 那条 `config-file-argv`)**:qwen 对这个 flag
    //    走的是 `parseMcpConfig` —— `readFile → stripJsonComments → JSON.parse → validate`,
    //    **全程没有环境变量解析**。于是 `${VAR}` 不展开,`Authorization` 只能以明文落进 run home,
    //    撞 session-capability-contract 的两句:「secret value 不进入 argv、静态 artifact」与
    //    「不得把认证字节复制进 run home」。
    //    实测(d15,qwen 0.23.0,2026-09-03,**同一份字节**只换通道的 A/B,假 MCP 端点抓真实请求头):
    //      · `--mcp-config <file>`                       → 收到字面串 `${GUGU_PROBE_TOKEN}`;
    //      · `QWEN_CODE_SYSTEM_SETTINGS_PATH=<file>`     → 收到展开后的真值 `Bearer NONCE-9c2f`。
    //    合并语义同时验了:用户自己 `~/.qwen/settings.json` 里那台 stdio server 照常被 spawn
    //    (阳性对照),系统级副本是**并入**不是替换。
    mcp: { kind: 'native', channel: 'system-config-overlay' },
    env: { kind: 'native', channel: 'child-process' },
    // 模型 —— 三个 canonical 的 OpenAI 变量，纯进程环境，一次都不落配置文件。
    //
    // 出处（官方用户文档 docs/users/configuration/auth.md 的鉴权矩阵那一行，逐字）：
    //   `OpenAI-compatible | openai | OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
    //    (alias: QWEN_MODEL) | OpenAI, Azure OpenAI, OpenRouter, ..., any OpenAI-compatible endpoint`
    // 「任意 OpenAI 兼容端点」是厂商自己写的，不是我们从「它是 OpenAI 兼容的」推的。
    //
    // ⚠️ 通道是 `process-config` 而不是 `child-process`：与下面 `env` 那条**不是一回事**。
    //    `env` 记的是「把用户/咕咕给的环境变量原样传下去」；这条记的是「咕咕按选中的模型
    //    **算出**一组变量再注进去」。两者同一个投递面、不同的来源，混写会让注入契约表对不上账。
    // ⚠️ 这一格记的是**选中的那一条**怎么落地(算出一组环境变量再注进去)。
    //    「这条会话还能换到哪几条」不走这里 —— 环境变量只表达得了一条 ——
    //    而是随 MCP 那份会话级 settings 一起,落成 qwen 自己的 `modelProviders`
    //    (见 `platformModelPatch`)。两者同一个模型维、不同的载体。
    model: {
      kind: 'per-surface',
      surfaces: {
        // 选中的那一条:三个 OpenAI 环境变量(`applyModelEnv`)。
        'acp': { kind: 'native', channel: 'process-config' },
        // 终端腿多一件事:**这条会话还能换到哪几条**,只有文件表达得了(环境变量表达不了一个列表)。
        // 载体与本家 MCP 那一格**是同一份** run-scoped 系统级 settings 副本
        // (读管理员那份 → 写咕咕 run 目录 → 用厂商自己的路径变量指过去)⇒ 同一个 channel 名。
        // ⚠️ ❌ 不能写成 `'config-file'`:那个 channel 的定义是「咕咕**自己那份配置根**里的文件
        //    (tomlOverlays / artifacts)」,与这条的落法不是一回事。写它能骗过
        //    `providerDeliversModelViaConfigFile` 的字面判断,但那是为了过闸门写一个假声明。
        'tui': { kind: 'native', channel: 'system-config-overlay' },
      },
    },
    // 自治级别 —— 走 **argv**（`--approval-mode`），会话级、零落盘。
    // 两条腿共用：ACP 腿是 `qwen --acp …`、TUI 腿是裸 `qwen`，同一个二进制、
    // 同一套 yargs，flag 落在真正执行工具的那个进程上。见下面 `autonomyArgs`。
    autonomy: { kind: 'native', channel: 'argv' },
    // 身份自述 —— 走 ③（`session-context`）：同一段话以**用户级载体**进到首轮的输入里。
    //
    // ⚠️ **这一格 2026-08-27 之前写的是 `first-turn-hidden-context`，那是一条送不到的通道。**
    //    它的载体是 `materialization.prompt`，宿主把它落成 `session/new` 的
    //    `_meta.systemPrompt.append` —— 而那个键是**咕咕自己的约定**，不是 ACP 协议的字段；
    //    只有咕咕给 codex 写的那座 shim 和 claude 的适配器在读。本家跑的是**厂商原生**的
    //    ACP server（`createNativeAcpBehavior`），`_meta` 对它是个开放 record，收下即丢。
    //    同形的 copilot 实测过：`_meta.systemPrompt.append` 命中 **0/6**，换成它自己的通道
    //    6/6，阳性对照证明仪器看得见（见 impl/copilot/session-bundle.ts）。
    //    ⚠️ 那一版的声明是**裸的**——同一个文件里别的维度都有密实的一手出处，唯独这一格
    //    一句注释都没有。它从来没被测量过。
    //
    // ⇒ 改走 ③：`session/prompt` 是协议的**主通道**，每个 ACP agent 都必须读它。
    //    这不是降级（behavior `agent-context-injection`「②③ 只差载体」），身份仍是系统
    //    提示词，照样不展示给用户。
    // ⚠️ 换通道**必须**同时让物化器自报 `carrier: 'session-context'` —— 漏了会静默回落
    //    系统位，也就是回到那个黑洞。conformance 有judge 钉这一对必须一致。
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        // 终端腿走 argv:`--append-system-prompt <正文>`(**追加**,原基座一字不动)。
        //
        // ⚠️ 这一格 2026-09-03 之前是 `none + unverified('session-TUI system-prompt')` —— 那不是
        //    「qwen 做不到」,是**咕咕没量过**。量了就通了。
        // ⚠️ 官方文档(users/features/headless)的示例一律写成 `qwen -p "…" --system-prompt "…"`,
        //    照抄会误判成 headless 专属;实物里这两个 flag 与 `--prompt` **平级**注册在主命令上,
        //    交互 TUI 同样吃。
        //    实测(d15,qwen 0.23.0,2026-09-03,起假 OpenAI 端点抓**真实上行请求的 system 消息**,
        //    ❌ 不看 CLI 自报):`-i` 交互腿给 flag → nonce 在 system 尾部命中、长度 27744→27784;
        //    同腿不给 flag → 不命中(阴控)。开头分别是 "interactive CLI agent" / headless 那两档的
        //    "non-interactive CLI agent",证明量的确实是交互基座。
        // ❌ **不能用 `--system-prompt`**:它整份替换基座,实测把 28233 字符打成 5652 ——
        //    qwen 自己的工具说明与安全约束会被一起冲掉。那不是注入,是换脑。
        // ⚠️ 通道是 `argv-append` 而不是 `prompt-file-argv`:qwen 这个 flag 收的是**正文字符串**,
        //    不是文件路径 —— 命令行里就是那段话本身,不产 artifact。
        'tui': { kind: 'native', channel: 'argv-append' },
      },
    },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  /**
   * ACP 行为仍由 qwen 原生 ACP 运行时提供（impl/qwen/index.ts 的
   * `provider.acp = createNativeAcpBehavior(['--acp', ...])`），但 sessionpage 入口当前关闭，
   * 因为 exact-head 产品闭环未通过。session-TUI 腿也没有这些控制能力（只有 `stopSession`，是**停止**不是暂停）。
   * 后两条与 surface 无关:introspection 走配置文件扫描,memory 读的是磁盘上 qwen 自己会去读的文件。
   */
  coexistence: {
    /**
     * 协议 cancel:`cancelTurn` → `cell.cancel()` → `agent.cancel({ sessionId })`
     * (session-runtime/src/acp-agents/session/cell.ts:287),turn 落到自己的 `cancelled` 结局
     * (session-core/src/acp/models/turns/turn.ts:22,45)。⚠️ 进程活着、会话还在 = 暂停,不是停止/移除。
     */
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /**
     * `session/update` 通知经 `buildAgentClient.sessionUpdate`
     * (session-runtime/src/acp-agents/agent-ports/agent-client.ts:51)进 cell,驱动
     * `AgentActivity active:true/false`(cell.ts:186,638)与 `TurnEnded`(cell.ts:421)
     * —— 咕咕观测得到「本轮在飞」。
     */
    observability: { kind: 'native', channel: 'acp-update' },
    /**
     * `session/request_permission` 落进 `pendingPermissions`(cell.ts:318),由人在会话界面
     * 选项后 `resolvePermission` 回填(apps/desktop/src/session/renderer/features/sessions/
     * acp/acp-chat-panel.tsx:377)—— 一条真通到人的路。
     */
    askUser: { kind: 'native', channel: 'permission-ask' },
    /** ACP `plan` 更新归一成结构化 `entries`(session-core/src/acp/reducer/normalized-event.ts:155),不是纯 markdown。 */
    todo: { kind: 'native', channel: 'acp-plan' },
    /**
     * `qwenMcpAdapter()`(impl/qwen/index.ts:76)扫**用户自己的** `~/.qwen/settings.json`
     * 的 `mcpServers`,`readServers` 把文件里每一条都报出来 —— 咕咕写的与用户手写的一视同仁
     * (session-core/src/agents/plugins/helpers/mcp.ts:145,101,经 plugin-host.ts:236 暴露)。
     * 不用启引擎 → config-scan。
     * ❌ 不含 hooks:本目录 hooks.ts 建出的 `readHooks` 只认 GUGU_HOOK_MARKER
     *    (helpers/hook-config.ts:157),报的是「咕咕自己装没装」,不是用户的 hooks。
     */
    introspection: { kind: 'native', channel: 'config-scan' },
    /**
     * 咕咕经 `AgentPluginHost.readMemoryFiles`(session-core/.../plugin-host.ts:270)读得到 qwen
     * 自己会去读的那几个文件 —— 具体登记在 `impl/qwen/index.ts` 的 `capabilities.memory`。
     * 通道取 `vendor-file`:qwen 这一维的主体是它的专名文件 QWEN.md(三处并列全读),
     * AGENTS.md 只是它顺带收编的跨厂商约定。
     * 厂商出处:https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md
     * ⚠️ 两处必须同通道。
     */
    memory: { kind: 'native', channel: 'vendor-file' },
    // ❌ 不写 history:core 的 `transcriptSources/` 注册表当前只有 claude-code 与 codex 两份 spec。
    //    接通它 = 在那里加一份 spec(qwen 是 ~/.qwen/projects 下的 jsonl)并登记进
    //    TRANSCRIPT_SOURCE_IDS,不是在这里改一行声明。
    // 其余 cron 咕咕全仓无接线,一并落回基类 —— 这是「咕咕还没接」,
    // 不是「qwen 做不到」。
  },
} satisfies SessionBundleDescriptor;

/** qwen 自己的系统级 settings 解析顺序:环境变量优先,否则按平台默认。逐字对齐发行包里的 `getSystemSettingsPath()`。 */
const QWEN_SYSTEM_SETTINGS_PATH_ENV = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';
const QWEN_SYSTEM_DEFAULTS_PATH_ENV = 'QWEN_CODE_SYSTEM_DEFAULTS_PATH';

function vendorSystemSettingsPath(bundle: SessionCapabilityBundle): string {
  const declared = bundle.env[QWEN_SYSTEM_SETTINGS_PATH_ENV]?.trim();
  if (declared) return declared;
  if (process.platform === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  if (process.platform === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  return '/etc/qwen-code/settings.json';
}

/**
 * ⚠️ qwen 的 `getSystemDefaultsPath()` 是从 **system settings 路径的目录**推出来的
 * (`join(dirname(getSystemSettingsPath()), 'system-defaults.json')`)。咕咕把前者指向自己的
 * run 目录时,**必须**同时把后者显式钉回原处 —— 否则管理员那份 `system-defaults.json` 会被
 * 一起顶掉:一处重定向,静默吞掉两份策略。
 */
function vendorSystemDefaultsPath(bundle: SessionCapabilityBundle): string {
  const declared = bundle.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]?.trim();
  if (declared) return declared;
  return join(dirname(vendorSystemSettingsPath(bundle)), 'system-defaults.json');
}

/**
 * qwen 内建的 OpenAI 兼容 authType 的键名。`modelProviders` 是**按 authType 分组**的,
 * 而咕咕的中转就是一个 OpenAI 兼容端点 ⇒ 这一组进 `openai`。
 */
const QWEN_PLATFORM_AUTH_TYPE = 'openai';

/**
 * 把**这条会话能换到的那一整组**咕咕平台模型落成 qwen 自己的 `modelProviders` ——
 * 于是用户在 qwen 的 `/model` 里就能换,而不是只看到启动时钉的那一条。
 *
 * ## 为什么是这个通道
 *
 * 三个 OpenAI 环境变量只表达得了**一条**模型(`OPENAI_MODEL`),所以在这条通道上
 * 「整组」根本写不出来。qwen 自己有 `modelProviders`(实装包自带文档
 * `bundled/qc-helper/docs/configuration/model-providers.md`,0.22/0.23 起):
 * 每个 authType 一个**裸数组**,`/model` 就是按它列的。
 * ⚠️ 那份文档同时点名两件会**静默**出错的事,下面两条注释各守一件。
 *
 * ⚠️ **凭据不进这份文件。** 文档原话:`Credentials are never persisted in settings;
 *    the runtime reads them from process.env[envKey]`。所以这里只写 `envKey` 的**名字**,
 *    值仍然只活在 `applyModelEnv()` 注进去的 `OPENAI_API_KEY` 里。
 * ⚠️ **必须是裸数组。** 早期预览版那种 `{ protocol, models: [...] }` 包装形式在
 *    `$version: 4` 的配置里会被**静默跳过** —— 症状是「`/model` 还是只有一行」,
 *    与「这段根本没写出去」完全同形。
 * ⚠️ **同一 authType 下按 `id` + `baseUrl` 去重**,重复的只留一条 warning 就丢。
 *    所以这里自己先去重,别把重复交给它去丢。
 */
function platformModelPatch(bundle: SessionCapabilityBundle): Record<string, unknown> | null {
  const model = bundle.model;
  if (!model || model.dialect !== 'qwen-openai-env') return null;
  const platform = model.platformProvider;
  const selected = model.model?.trim();
  // 非平台会话(BYOK)一个字都不写 —— 与 `applyModelEnv` 同一条理由:
  // 那会把用户自己配的模型清单顶掉。
  if (!platform || !selected) return null;
  const declared = model.platformModels?.length
    ? model.platformModels
    : [{ id: selected, displayName: selected, contextWindow: null }];
  const seen = new Set<string>();
  const models: Record<string, unknown>[] = [];
  for (const entry of declared) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: entry.displayName?.trim() || id,
      // 每条都显式钉端点:这一组只在咕咕的中转上成立,省略会落到 authType 的默认端点。
      baseUrl: platform.baseUrl,
      // ⚠️ 只有**名字**。见上面那条凭据红线。
      envKey: 'OPENAI_API_KEY',
    });
  }
  // 选中的那条必须在表里 —— 目录与令牌之间有任何时序差时,至少这一轮换得回来。
  if (!seen.has(selected)) {
    models.unshift({ id: selected, name: selected, baseUrl: platform.baseUrl, envKey: 'OPENAI_API_KEY' });
  }
  if (models.length === 0) return null;
  return {
    modelProviders: { [QWEN_PLATFORM_AUTH_TYPE]: models },
    /**
     * ⚠️ **把这次会话选中的那条钉在系统级那份里** —— owner 2026-09-07 定的口径(B):
     * 「这条会话的模型身份由**发起它的那次选择**决定;用户在终端里的临时切换是**会话内**的事,
     *   不该变成全局默认。」
     *
     * 为什么必须钉:qwen 的 `/model` 会把用户选的那条**写进他自己的** `~/.qwen/settings.json`
     * (实测 0.23.0:`"model": { "name": "gpt-5.4", "baseUrl": … }`),而那份是**跨会话**的。
     * 不钉的话,下一条咕咕会话会从上一次终端里换的那条起,而 composer 上写着另一个 ——
     * 那正是「界面说 A、实际跑 B」。
     *
     * 为什么钉在**这一份**就够、而且不碰用户的文件:qwen 自己文档的优先级表
     * (`docs/configuration/settings.md`,0.23.0)——
     *   2 system-defaults < 3 user < 4 project < **5 system settings** < 6 env
     * 「System settings override user and project settings」。咕咕写的正是第 5 层。
     * ⇒ ❌ 不需要、也不许去改用户那份(`agent-config-boundary` 红线)。
     *
     * ⚠️ 这只钉**启动那一刻**。会话跑起来之后用户在 `/model` 里换,照常生效 ——
     * 设置是启动时读的,换掉的是运行时状态。「不许逃出这条会话」≠「不许换」。
     */
    model: { name: selected, baseUrl: platform.baseUrl },
  };
}

type SystemSettingsDelivery = { overlay: JsonOverlay; env: Record<string, string> };

/**
 * 会话包的 `alwaysLoad` → qwen server 条目上的原生开关 `alwaysLoadTools`:工具直接上模型的工具表,
 * 不藏在 `tool_search` / `tool_call` 桥后面。出处:发行包 0.24.4 `DiscoveredMCPTool` 构造读
 * `mcpServerConfig.alwaysLoadTools === true`;实测见 descriptor 的 units.mcp。
 */
function alwaysLoadTools(server: SessionMcpServer): { alwaysLoadTools?: true } {
  return server.alwaysLoad ? { alwaysLoadTools: true } : {};
}

/**
 * 咕咕自有那台 server(`owner: 'gugu'`)→ qwen 条目上的 `trust: true`。
 *
 * spec capability-bundle:咕咕自有 MCP server 的产品工具(`message_send` 等)不属于审批范围,
 * ❌ 不得被改路由成审批请求。qwen 对 MCP 工具的默认权限是 `ask`,只有 `trust === true` 且工作区
 * 受信(folderTrust 未开启时恒真)才是 `allow`(发行包 0.24.4 `DiscoveredMCPToolInvocation.getDefaultPermission`)。
 * 实测(#6192 B 首轮,mac1):不带 trust 时 `message_reply` 停在「Allow message_reply (gugu MCP Server)」
 * 审批条上直到判据超时 —— session/new 那条老路同样不带 trust,只是之前模型连名字都够不着,轮不到这一步。
 * ❌ 集成与用户的 server 不给:它们仍按 qwen 自己的审批走。
 */
function trustGuguOwned(server: SessionMcpServer): { trust?: true } {
  return server.owner === 'gugu' ? { trust: true } : {};
}

/**
 * 把本会话的咕咕 MCP server 落成 qwen 真吃的那份**系统级** settings —— source-backed overlay:
 * 读用户(管理员)当下那份系统配置 → 合并咕咕的补丁 → 写进咕咕自己的 run 目录 → 用厂商自己的
 * 路径环境变量指过去。用户的任何配置文件一个字节不动。
 *
 * ⚠️ `Authorization` 走 `${VAR}` 占位符 + child env,**真值不进 overlay 的字节**。这条通道能这么写
 *    的前提就是 settings 加载器会展开占位符(实测见 descriptor 的 units.mcp);换成 `--mcp-config`
 *    这一句立刻不成立。
 * ⚠️ `url` 写**字面值**:它不是 secret,而且这份文件 run-scoped、随目录消亡,没有「残留指向旧端口」
 *    的问题 —— 旧实现在用户的持久配置里写占位符正是为了躲那个问题,这里不需要。
 * ⚠️ 声明了 `authorizationEnv` 却拿不到值 = 配置残缺,fail loud,❌ 不静默发一个没着落的占位符。
 */
function systemSettingsDelivery(
  bundle: SessionCapabilityBundle,
  surface: 'acp' | 'tui'
): SystemSettingsDelivery | null {
  // 整组可切模型只属于终端腿(见 descriptor 的 units.model);ACP 腿的模型仍只走三个环境变量。
  const modelPatch = surface === 'tui' ? platformModelPatch(bundle) : null;
  // 咕咕的 hooks 只有终端腿消费(descriptor `hooks.channel = 'session-env'`)⇒ 终端腿**总会**交付这份 settings。
  // ACP 腿只在有 MCP 或平台模型时才要它 —— 两半各自可选,没配 MCP 但选了咕咕模型的会话同样要有 `modelProviders`。
  const hooks = surface === 'tui' ? nestedHooksObject(qwenHookSpecs()) : null;
  if (!hooks && bundle.mcpServers.length === 0 && !modelPatch) return null;
  const servers = Object.fromEntries(
    bundle.mcpServers.map((server) => {
      if (server.transport === 'stdio') {
        assertSessionMcpStdioEnv(server, bundle, 'Qwen');
        return [server.name, { ...sessionMcpStdioConfig(server), ...alwaysLoadTools(server), ...trustGuguOwned(server) }];
      }
      sessionMcpAuthorization(server, bundle.env, 'Qwen');
      // ⚠️ 条目形状必须是 qwen 家的**原生方言**(`httpUrl` + 注入 `Accept`),而且必须来自
      //    `geminiFamilyHttpMcpEntry` 这**一份**翻译 —— 手写一份同义的会静默漂移,而漂移的
      //    后果(缺 Accept ⇒ streamable-HTTP 被 406)只有真端点照得出,假端点什么都收。
      return [
        server.name,
        {
          ...geminiFamilyHttpMcpEntry(
            server.url,
            server.authorizationEnv ? { Authorization: `\${${server.authorizationEnv}}` } : {}
          ),
          ...alwaysLoadTools(server),
          ...trustGuguOwned(server),
        },
      ];
    })
  );
  const path = join(sessionRunHome(bundle, 'Qwen', 'qwen-capability-runs'), 'qwen-system-settings.json');
  return {
    overlay: {
      sourcePath: vendorSystemSettingsPath(bundle),
      path,
      patch: {
        ...(bundle.mcpServers.length > 0 ? { mcpServers: servers } : {}),
        ...(modelPatch ?? {}),
        // ⚠️ 这是 qwen 的 **system** 层:它与用户层的 hooks 并列装载、各事件 concat,
        //    用户自己的 hooks 照常生效。条目都带 `GUGU_HOOK_PORT` 守卫 —— 咕咕以外的进程读到也是 no-op。
        // 管理员的系统级 settings 里若已有同名事件的 hooks,与咕咕的**拼接**(`concatArraysUnder`),
        // 与 qwen 自己的合并语义一致 —— ❌ 不顶掉他的,也 ❌ 不因此拒绝起会话。
        ...(hooks ? { hooks } : {}),
      },
      conflict: 'fail',
      concatArraysUnder: ['hooks'],
      mode: 0o600,
    },
    env: {
      [QWEN_SYSTEM_SETTINGS_PATH_ENV]: path,
      [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: vendorSystemDefaultsPath(bundle),
    },
  };
}

/**
 * 把选中的模型落成 qwen 认的那三个环境变量。**两条腿共用** —— qwen 的 ACP 面与 TUI 面是同一个
 * 二进制、同一个进程环境，所以这里不按 surface 分叉（codex 要分是因为它落 `-c` 旗标，
 * 而旗标只在它自己那套 argv 上成立）。
 *
 * ⚠️ 三个键**缺一不可**。缺 `OPENAI_MODEL` 时 qwen 不是退回默认模型，而是**拒绝启动**
 *    （`No auth type is selected...`）——它靠这组变量是否齐全来自动选中 `openai` 鉴权类型。
 *    实测 0.22.0，隔离 HOME + 本地假 OpenAI 端点，含变异对照与「同 HOME 补回 MODEL 又通」的
 *    变量隔离；配方与读数见 PR 描述。⇒ 下面的 early-return 是「不成立就一个键都别发」。
 * ❌ 非平台会话（BYOK / 用户自己的 key）这里一个键都不发 —— 那会把用户自己选的端点顶掉。
 */
function applyModelEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  const model = bundle.model;
  if (!model) return;
  if (model.dialect !== 'qwen-openai-env') {
    throw new Error(`Qwen session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return;
  const selected = model.model?.trim();
  if (!selected) return;
  env.OPENAI_BASE_URL = platform.baseUrl;
  env.OPENAI_API_KEY = platform.apiKey;
  env.OPENAI_MODEL = selected;
}

function baseReport(
  ctx: SessionMaterializationContext,
  mcp: SessionMaterialization['report']['units']['mcp'],
  promptLoaded: boolean,
  modelLoaded: boolean,
  autonomyLoaded: boolean
): SessionMaterialization['report'] {
  const loaded = { status: 'loaded' as const };
  return {
    adapterId: 'qwen',
    surface: ctx.surface,
    units: {
      mcp,
      env: loaded,
      model: modelLoaded
        ? loaded
        : { status: 'degraded', reason: { code: 'unverified', reason: 'No model was declared.' } },
      autonomy: autonomyLoaded
        ? loaded
        : { status: 'degraded', reason: { code: 'unverified', reason: 'No autonomy was declared.' } },
      promptBlocks: promptLoaded
        ? loaded
        : { status: 'degraded', reason: noPromptBlocks },
      packages: { status: 'degraded', reason: unverifiedExtension },
    },
    discoveredCommands: [],
  };
}

/**
 * 把咕咕的自治档位落成 qwen 的 argv。**两条腿共用**。
 *
 * qwen（实测 `@qwen-code/qwen-code@0.22.0`）的审批只有一个入口：CLI flag `--approval-mode`，
 * 枚举五档 `plan | default | auto-edit | auto | yolo`（yargs 定义逐字如此；给个野值它会把
 * 合法值全吐出来：`Argument: approval-mode, Given: "bogus", Choices: …`）。
 *
 * ⚠️ **没有任何审批环境变量。** 双重取证：(1) 把发行包里 289 个 env 名全解析出来，
 * `QWEN_APPROVAL_MODE` / `QWEN_CODE_APPROVAL_MODE` / `QWEN_YOLO` 之类零命中，而同一把尺子下
 * `OPENAI_MODEL` / `QWEN_SANDBOX` / `QWEN_HOME` / `QWEN_CODE_SAFE_MODE` 全部命中（仪器有效）；
 * (2) 同时设 7 个候选名再实跑，那条 yolo 警告不出现，而改设置文件时它会出现（判据能红能绿）。
 * ⇒ 这一维只能走 argv，❌ 别去找环境变量。
 *
 * 咕咕的两档映射（对齐 **codex 那一家的同名档**，同一个档在不同引擎上得是同一个意思）：
 *
 * · `full-access`       → `yolo`（官方原文 "auto-approve all tools"）
 * · `approval-required` → `default`（官方表：File Editing 与 Shell Commands 都是
 *   "Manual approval required"）
 *
 * ❌ **为什么 `approval-required` 不用 `auto-edit`**：它看着更像 codex 的
 * `on-request` + `workspace-write`（自动放行编辑、shell 仍要问），但 codex 那一档的
 * 「编辑自动放行」是**被沙箱关在工作区里**的，而 qwen 在 Linux 上根本没有沙箱可用
 * （Seatbelt 是 macOS 独占，Linux 只剩 docker/podman，`QWEN_SANDBOX=true` 在没装容器的机器上
 * 直接拒启）。不开沙箱时 qwen 的写入**没有任何工作区牢笼** —— 核过 edit/write 工具的路径
 * 校验，只有「必须是绝对路径」，没有任何越界拒绝（同一把尺子能搜到别的越界串，仪器没坏）。
 * 所以 `auto-edit` 在这里的真实含义是「自动放行**对任意路径**的写入」，比 codex 那一档松得多，
 * ❌ 不能拿来当它的对应物。
 *
 * ❌ **为什么不用 `auto`**：那是让一个 LLM 分类器逐条判危险。换了信任模型（由模型来裁决安全），
 * 用户从没表达过要这个，而且每次工具调用都要烧一次推理。
 *
 * ⚠️ `--yolo` / `-y` 是另一个入口，与 `--approval-mode` **互斥**，一起给直接报错退出。
 *    所以只发 `--approval-mode`，❌ 别两个都塞。
 *
 * ⚠️ **argv 赢过一切**，包括 system scope 的设置文件（实测 system settings 写 `default`
 *    + 命令行 `--approval-mode=yolo` → yolo 生效）。⇒ 没法用配置文件给会话钉一个不可突破的上限；
 *    真正的硬底线只有 `permissions.deny` 规则和真沙箱，那是另外的轴，这一刀不碰。
 *
 * ⚠️ `yolo` **不自带沙箱**，headless 下 qwen 自己会在 stderr 打一行
 *    "All tool calls (shell, write, edit) auto-execute at this process's privilege level."
 *    —— 那是厂商的诚实提示，不是咕咕的 bug。
 */
function autonomyArgs(bundle: SessionCapabilityBundle): string[] {
  if (!bundle.autonomy) return [];
  const mode = bundle.autonomy.mode === 'full-access' ? 'yolo' : 'default';
  return ['--approval-mode', mode];
}

/**
 * 终端腿的系统提示词 —— `--append-system-prompt <正文>`。
 *
 * ⚠️ 一个块都没有时返回 `[]`,**一个 flag 都不发**:发一个空串会让「声明 native 却什么都没投递」
 *    在只看 argv 长度的判据下静默变绿。
 */
function promptArgs(bundle: SessionCapabilityBundle): string[] {
  const value = sessionPromptText(bundle.promptBlocks)?.value;
  return value ? ['--append-system-prompt', value] : [];
}

export function materializeQwenSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!qwenSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Qwen session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const surface = ctx.surface as 'acp' | 'tui';
  const systemSettings = systemSettingsDelivery(bundle, surface);
  if (systemSettings) Object.assign(env, systemSettings.env);
  applyModelEnv(bundle, env);
  // 提示词两条腿载体不同:ACP 腿走 session/prompt(`session-context`),终端腿走 argv。
  const acpPrompt = surface === 'acp' ? sessionContextPrompt(bundle.promptBlocks) : undefined;
  const prompt = surface === 'tui' ? promptArgs(bundle) : [];
  return {
    argsAppend: [...autonomyArgs(bundle), ...prompt],
    env,
    ...(acpPrompt ? { prompt: acpPrompt } : {}),
    configMerges: [],
    artifacts: [],
    ...(systemSettings ? { jsonOverlays: [systemSettings.overlay] } : {}),
    report: baseReport(
      ctx,
      // ⚠️ MCP 那格只看**有没有 MCP server**,❌ 不看这份 settings 在不在:
      //    终端腿上它总会生成(hooks 住在里面),那时 MCP 可能一台都没有。
      bundle.mcpServers.length > 0
        ? { status: 'loaded' }
        : { status: 'degraded', reason: unverified('MCP server') },
      surface === 'acp' ? Boolean(acpPrompt) : prompt.length > 0,
      Boolean(bundle.model),
      Boolean(bundle.autonomy)
    ),
  };
}
