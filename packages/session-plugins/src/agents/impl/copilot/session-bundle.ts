import { harnessPlatform } from './platform';
import {
  join,
} from 'node:path';
import type {
  NativeHome,
  Degradation,
  GeneratedArtifact,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';
import {
  materializeAcpSessionBundle,
  sessionRunHome,
} from '../../helpers/session-bundle';

export const COPILOT_ACP_VERSION = '1.0.79';
export const COPILOT_ACP_SOURCE =
  '@github/copilot-darwin-arm64@1.0.79 app.js esbuild-expanded lines 103154-103157 parse session/new and call newSession; lines 104508-104516 pass e.mcpServers through hlt into awaited startSessionMcp; lines 104163-104179 map HTTP/SSE name, URL and headers; lines 104308-104340 merge config and await mcp.reloadWithConfig.';

const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `GitHub Copilot CLI ${COPILOT_ACP_VERSION} ${unit} delivery has not been verified from its published agent bytes.`,
});

export const copilotSessionBundleDescriptor = {
  injectionMode: 'runtime',
  nativeHome: { envVar: 'COPILOT_HOME', userPath: '.copilot', evidence: '@github/copilot:配置根整个由 COPILOT_HOME 挪走,默认 ~/.copilot' } satisfies NativeHome,
  platform: harnessPlatform,
  shellEnv: { passThrough: ['COPILOT_CLI_TOKEN'] },
  // 平台令牌是四个 `COPILOT_PROVIDER_*` 里的 `_API_KEY`,两条腿都只在进程环境(model = process-config,
  // 不落文件、不进 argv)。进程起来后换不了值 ⇒ 到期按原形态重开。
  credentialLifecycle: {
    'acp': {
      delivery: 'child-process-env',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      /**
       * 换计费路要换一条新的原生会话(#6210)。copilot 1.0.82 `session/load` 后回到会话自己记的模型,
       * 不看进程带的 `COPILOT_PROVIDER_MODEL_ID`;而走自定义 provider 时 `session/new` / `session/load` /
       * `set_config_option` 的应答里**都不报**模型(#6182 裸 ACP 实测)⇒ 回到「你自己的模型(默认)」时
       * 没有一个可断言的值能把会话里记着的平台模型顶掉,续接的会话只能拿用户自己的凭据去调平台那个 id
       * (mac1 读数:记录端点收到 `glm-5.3`)。新的原生会话没有这份记忆,由 copilot 自己取默认。
       * 终端腿没量,保持 `preserve`。
       */
      sourceChangeSession: 'replace',
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
   * 关自更新(#6186)。copilot 自己的帮助页写着这个 env;不关时它把新版下载进
   * `~/Library/Caches/copilot/pkg/<平台>/<版本>`,而 npm 启动器每次都挑那里最新的一份跑 ——
   * 同机会话的版本随下载漂移。关掉之后跑的是用户安装的那一份(启动器同一个判断)。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { COPILOT_AUTO_UPDATE: 'false' },
    evidence:
      'https://www.npmjs.com/package/@github/copilot/v/1.0.86 发行包 app.js 内置 `copilot help environment`:'
      + '「COPILOT_AUTO_UPDATE: set to "false" to disable downloading updated CLI versions automatically」;'
      + ' 同包 index.js 启动器在该值为 false 时不再选缓存里的新版。取证 2026-09-23',
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    // 第三轴 injection（spec session-injection，next-tool-call 铺开第一批 2026-09-01）：
    // 忙时第二条**标准** `session/prompt` **打断**运行中的工具（tool → `interrupted`）并把暗号折进本轮续写，
    // 暗号在首个 tool-boundary 请求（携 turn-1 的 tool 调用+result）进模型 —— busy 3/3 + idle 阳控 1/1
    // （copilot 1.0.82，本地假端点；droid 同形的 interrupt+fold）。
    // ⚠️ 与 #4500 的**产品**面 idle-only 读数不矛盾：那条 idle-only 的成因是**咕咕自己一侧的排队**
    //    （device deliver 把消息扣到 turn 末），不是 harness 上限。声明 next-tool-call 后咕咕改走 steer 腿
    //    （`steerIfBusy` 直发同一条并发 `session/prompt`），正是本读数走的这条路。
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence:
          'https://www.npmjs.com/package/@github/copilot/v/1.0.82 实测（2026-09-01，本地假端点）：copilot ACP busy 3/3 next-tool-call + idle 1/1；'
          + 'harness-native，与 #4500 产品 idle-only 的成因是咕咕排队非 harness 上限',
        // steer **打断**在飞工具(tool → `interrupted`)再折入,不是 droid 那种不打断的 fold ——
        // 忙时给 copilot 发消息会中止它正在跑的那个工具。读声明的人光看 `next-tool-call` 分不出这一点,
        // 故记进机器可见的 deviations(comments 过不了 zod parse)。
        deviations:
          '忙时 steer 会打断在飞工具(tool → interrupted)再把暗号折进本轮续写 —— 与 droid 不打断的 fold 有别;用户在 copilot 忙于构建时插话会中止那个工具',
      },
    },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
  },
  /**
   * tui 的会话级 MCP 走 `--additional-mcp-config @<file>`,该 flag 在 1.0.79/80/81/82
   * 四个发行版的 app.js 字节里逐一验证在场(npm tarball grep,2026-09-01)。1.0.79 以下未验证
   * ⇒ floor 钉在**最老的已验证版**。低于 floor 时宿主在 spawn 前 fail loud(带实际版本与
   * 修复入口),❌ 不许静默降级成没有 gugu 工具的哑会话 —— 那正是 #4568 的病。
   */
  runtimeCompatibility: {
    'tui': {
      kind: 'semver-supported-floor',
      supportedFloor: '1.0.79',
      versionArgs: ['--version'],
    },
  },
  units: {
    // MCP —— **两条腿答案不同**。
    //
    // ⚠️ 这一格 2026-08-28 之前是扁平声明(= 两条腿都 native),而 `acp-session` 的载体是
    //    `session/new` 的 `mcpServers`,**终端腿上根本没有这个东西**:PTY 那条路只取
    //    `argsAppend` / `env`。而通用物化的 `unitReport` 是按 descriptor 报数的,于是终端腿
    //    恒定报 `mcp: loaded` —— 一个字节都没送,报告却说送到了。
    //    owner 2026-08-28 在 kimi 上实测撞到(报告写 loaded、机器上连配置文件都不存在)。
    //    ⇒ 如实按腿声明。现在通用物化对这种声明直接抛,不会再有第二次。
    //
    // tui 这一格 2026-09-01 从 `none + unverified` 升为 `config-file-argv`(#4657 层4):
    // 咕咕把会话 MCP 写成 run-scoped 0600 文件,argv 上只挂 `--additional-mcp-config @<路径>`;
    // Authorization 在文件里是 `${VAR}` 占位符、真值走 child env(copilot 只在 headers 里做
    // env 展开,url 不展开 —— 两格实测见 sessionMcpDelivery 抬头)。连接侧实测(mac1,copilot
    // 1.0.82,隔离 COPILOT_HOME + 假 provider 端点,零真实推理):`-p` 与交互 pty 两模式均完成
    // server/discover→initialize→notifications/initialized→tools/list 四连,Authorization 头
    // 逐请求在场;无 flag 阴控 0 命中。
    // ⚠️ **同名碰撞语义(实测)**:用户 `~/.copilot/mcp-config.json` 里已有同名 server 时,
    //    会话 @file 的那份**静默赢**(会话路由 4 命中、用户路由 0 命中、零冲突输出),
    //    用户文件一个字节未动、shadow 仅本会话有效。这是厂商语义;对 gugu 是**正确**行为
    //    (gugu 会话内的 gugu 工具必须是 gugu 自己的那份),按文档化处置,❌ 不额外加拦截。
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        'tui': { kind: 'native', channel: 'config-file-argv' },
      },
    },
    // 会话环境变量 —— 直接 export 在 `copilot --acp` 这个进程上，零落盘。
    //
    // 实测 @github/copilot 1.0.80（2026-08-25，隔离 HOME + 本地假 provider 端点，零推理请求）：
    // 咕咕投进去的变量原样穿透到 agent 起的子进程，`COPILOT_HOME` 指向空目录跑完没生成任何文件。
    //
    // ⚠️ **安全形状**：它给子进程的是「全量父环境**减**一张黑名单」，不是白名单。所以任何
    //    不在那张黑名单上的凭据，会到达 agent 启动的**每一个** bash 命令、MCP server、
    //    LSP server、扩展和 hook —— 不只是 bash 工具。这条通道天生如此（`child-process` 的
    //    含义就是这个），所以下面把 MCP 的 Bearer 令牌显式剔掉：它已经在 ACP 的请求头里了，
    //    没有任何理由再进子进程环境。
    env: { kind: 'native', channel: 'child-process' },
    // 模型 —— 四个 `COPILOT_PROVIDER_*` 一起给,纯进程环境,不落配置文件、不进 argv。
    //
    // 实测 @github/copilot 1.0.80(隔离 HOME + 本地假 OpenAI 端点,**未登录任何账号**):
    // 请求打到假端点、`Authorization` 是我们给的 key、body 的 `model` 是我们给的 id,
    // 且 copilot 把假端点的回复原样打了出来;换 key 换 model id 的变异对照读数跟着变。
    //
    // ⚠️ 它**一个 canonical 名字都不读** —— `OPENAI_BASE_URL` / `OPENAI_API_KEY` 对它毫无作用。
    //    ❌ 别因为「它也是 OpenAI 兼容」就假设能复用 qwen 那套变量;协议同、变量名各家自定。
    model: { kind: 'native', channel: 'process-config' },
    // 自治级别 —— 走 **argv**，纯会话级、零持久化。
    //
    // 实测 @github/copilot 1.0.80（gitCommit a3a2697）：把 `COPILOT_HOME` 重定向到空目录后
    // 跑这些权限 flag，结束时那个目录里**根本没生成 settings.json** ⇒ 一个字节都没落盘。
    // 阳性对照：同一把尺子下 `--experimental` **确实**写进了 settings.json，
    // 证明「没写入」不是仪器坏了，是它真的只作用于本进程。
    //
    // ⚠️ argv 落在**执行工具的那个进程**上才算数。copilot 是原生 ACP（`copilot --acp`），
    //    没有独立的 app-server，两条腿的 argv 都落在 copilot 本体 —— 不是 codex 那个坑
    //    （它的 `-c` 属于背后的 app-server，挂到可见 TUI 上什么都钉不住）。
    //
    // ⚠️ 环境变量这条路**几乎没有**：把 bundle 里 commander 的 env 绑定全量枚举，
    //    整个 CLI 只有一条 `COPILOT_ALLOW_ALL`；allow-tool / deny-tool / available-tools /
    //    add-dir / sandbox 一概没有 `COPILOT_*` 对应物，只能走 argv。
    autonomy: { kind: 'native', channel: 'argv' },
    /**
     * 系统提示 —— 咕咕自己写一份 `*.instructions.md`,再用
     * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 把那个目录指过去。**两条腿共用**(同一个二进制、
     * 同一个进程环境),零 argv、不碰用户的工作区、不动 `COPILOT_HOME`。
     *
     * ⚠️ **这一格上一版写的是 `first-turn-hidden-context`,那是一条今天什么都送不到的通道。**
     * 它的载体是 `materialization.prompt`,宿主把它落成 `session/new` 的
     * `_meta.systemPrompt.append`(session-runtime `session-manager.ts` 的 `sessionOpenMeta`)——
     * 而那个键是**咕咕自己的约定**,只有咕咕给 codex 写的那座 shim
     * (`electron/runtime/codex-app-server-acp.mjs`)在读。copilot 跑的是厂商自己的原生 ACP
     * server,`_meta` 对它是个开放 record,收下即丢。
     *
     * 实测 @github/copilot-linux-x64 1.0.80(2026-08-26,隔离 HOME + 本地假 OpenAI 端点,
     * 未登录任何账号,自写 ACP stdio 客户端跑 initialize → session/new → session/prompt,
     * 数发往假端点的 6 个真实请求里标记出现几次):
     *  · `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<目录>` + `<目录>/x.instructions.md` → **6/6**,
     *    且落在 **role=system** 那条消息里(紧跟在它自己的工具说明之后);
     *  · 反例①`_meta.systemPrompt.append`(＝咕咕今天走的那条)→ **0/6**;
     *  · 反例②`session/new.additionalDirectories`(它的 schema 里真有这一格)→ **0/6**;
     *  · 阳性对照 `AGENTS.md` 放在 `session/new.cwd` 里 → **6/6** ⇒ 仪器看得见自定义指令,
     *    上面那两个 0 是读数不是仪器坏。
     *
     * ⚠️⚠️ **文件名后缀是判据本身**:同一个目录里放 `AGENTS.md` → **0/6**(复跑两次),
     *    换成 `*.instructions.md` → 6/6。而 GitHub 官方文档说这个变量收的是
     *    「Additional `AGENTS.md` and `*.instructions.md` files」—— **照文档写 `AGENTS.md`
     *    是静默无效的**。❌ 别改文件名。
     * ⚠️ frontmatter(`applyTo`)**不是必需**的:不写 → 照样 6/6;写了反而会把
     *    `---\napplyTo: '**'\n---` 逐字带进系统提示。所以这里不写。
     * ⚠️ 变量是**逗号分隔的列表**且每个目录都会被读(实测两个目录两个标记各 6/6),
     *    所以下面是追加而不是覆盖。
     */
    promptBlocks: { kind: 'native', channel: 'session-prompt-file' },
  },
  extension: { kind: 'none', degraded: unverified('extension') },
  // 只写咕咕**真接通了**的维度;没写的落回 BASE_SESSION_COEXISTENCE(= 尚未接通)。
  coexistence: {
    // acp 是原生腿(`copilot --acp`,createNativeAcpBehavior 直接 spawn,中间没有咕咕自建的桥),
    // 所以走 ACP 协议自己的 `session/cancel` —— 咕咕侧的 cancelled turn 状态机见
    // session-core/src/acp/models/turns/turn.ts。⚠️ 暂停 ≠ 停止:进程活着、会话还在。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // 同一条腿的 session 状态机把「本轮在飞」算进了咕咕自己的会话状态词汇:
    // session-runtime/src/acp-agents/machine/machine.ts 的 projectSessionState 产出
    // isGenerating / canCancel / backgroundAgentCount。
    observability: { kind: 'native', channel: 'acp-update' },
    // 授权型问话已真通:cell.ts 的 requestPermission 把带选项的请求挂进 pendingPermissions,
    // 用户点完由 resolvePermission(requestId, optionId) 回填 —— 一条完整的「通到人」往返。
    // ❌ 澄清型(「选 A 还是 B」)没通:mcp-elicitation / native-tool 均不许声明。
    askUser: { kind: 'native', channel: 'permission-ask' },
    // 同一条原生腿上,plan 更新原样进咕咕的 reducer,落到结构化的 `{ kind: 'plan', entries }`
    // (session-core/src/acp/reducer/normalized-event.ts)。没有中间桥会把它降级成 thought 文本。
    // ⚠️ `todo` 曾按「surfaces 含 acp ⇒ 收得到结构化 plan」声明过,已撤 —— 那是横切外推,
    // 被考卷当场判为「声明了做不到」:#3889 的官方证据里 copilot 的 todo 状态是 **none**(仅plan.md文件),
    // 即厂商这一端根本不产出结构化 plan 事件,咕咕的 decode 再全也无从收起。
    // ❌ 措辞注意:整条落回基类 = 咕咕没接通;不许改写成 `none + unsupported-channel` 替厂商下结论。
    // copilotMcpAdapter() 解析用户自己的 `~/.copilot/mcp-config.json`(外加旧路径
    // `~/.config/github-copilot/mcp.json`),不用启引擎 → config-scan。
    // ❌ 不含 hooks:readHooks 只认 GUGU_HOOK_MARKER,报的是「咕咕自己装没装」,不是用户的 hooks。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 引擎自己会去读的指令文件已登记在 `index.ts` 的 `capabilities.memory`,宿主经
    // `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `agents-md`:copilot 明确支持跨厂商的 `AGENTS.md` 约定(登记里同时有它自己的
    // `copilot-instructions.md`,走 vendor-file)。
    memory: { kind: 'native', channel: 'agents-md' },
    // ❌ 仍不写 `todo`:#3889 的官方证据里 copilot 这一维是 **none**(仅 plan.md 文件),
    // 厂商这端根本不产出结构化 plan 事件 —— 声明 acp-plan 会被考卷当场判为「声明了做不到」。
    // ⚠️ `pause` 保持 ACP 腿的 `protocol-cancel`,**不**改成 `interrupt-key`:一维只记得下一个
    // channel,而 protocol-cancel 是更强的那条。TUI 腿的中断键单独记在下面的 `sessionTuiInterrupt`
    // 里(判据见 tui-coexistence.ts 的 `tuiInterruptSurfaceRequirement`:按「有没有 pty 可写」判,
    // 不按 pause 的 channel 判)。
  },
  /**
   * TUI 腿的中断键 —— 让 `ptyController.interrupt` 对 copilot 的 pty 会话有字节可写。
   *
   * 出处:https://docs.github.com/en/copilot/concepts/agents/copilot-cli/cancel-and-roll-back
   * (取证 2026-08-24)。该页说明:Copilot 正在干活时,**第一下** Esc 只弹一句
   * 「Esc again to cancel」提醒,**第二下**才真正取消;Esc 本身永远不会退出会话。
   *
   * ⚠️ 所以 `presses` 必须是 2 —— 只写一下 Esc 等于什么都没做,界面却会报「已暂停」。
   * ❌ 不用 Ctrl-C:同一页写明「Pressing Ctrl+C a second time within two seconds, when the
   * input area is empty, exits the session」—— 那是**停止**甚至退出,不是暂停。本维只做暂停。
   * ⚠️ 已知不完美:同页说第二下 Esc 在**有排队提示词**时先删掉最近排队的那一条,队列空了才取消。
   * 即用户排了队时这一次中断可能落空 —— 那是「没停下」,不是「停错了」,可接受。
   * ⚠️ `intervalMs` 官方**没给**窗口时长,120ms 是工程取值:够长,不会被终端当成一次按键的
   * 重复;够短,不会等到提醒过期。键位本身有出处,这个数没有 —— 它是可调的,不是抄来的。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    presses: 2,
    intervalMs: 120,
    evidence:
      'GitHub Copilot CLI 官方取消文档:第一下 Esc 只显示 "Esc again to cancel",第二下才取消;'
      + 'Ctrl+C 连按两下会退出会话 — '
      + 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/cancel-and-roll-back '
      + '(取证 2026-08-24)',
  },
} satisfies SessionBundleDescriptor;

/**
 * 把选中的模型落成 copilot 认的那四个环境变量。**两条腿共用** —— TUI 面与 ACP 面是同一个
 * 二进制、同一个进程环境。
 *
 * ⚠️ 四个键缺一不可,`COPILOT_PROVIDER_TYPE` 尤其不能省:它是「按自定义 provider 走」的
 *    开关本身,少了它另外三个都不会被当回事。
 * ❌ 非平台会话(BYOK / 用户自己的 key)一个键都不发 —— 那会把用户自己配的 provider 顶掉。
 */
function applyModelEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  const model = bundle.model;
  if (!model) return;
  if (model.dialect !== 'copilot-provider-env') {
    throw new Error(`Copilot session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return;
  const selected = model.model?.trim();
  if (!selected) return;
  env.COPILOT_PROVIDER_TYPE = 'openai';
  env.COPILOT_PROVIDER_BASE_URL = platform.baseUrl;
  env.COPILOT_PROVIDER_API_KEY = platform.apiKey;
  env.COPILOT_PROVIDER_MODEL_ID = selected;
}

/**
 * copilot 接收起始推理档的 argv 旗标(`copilot --help`:`--effort, --reasoning-effort <level>`)。
 * 终端腿由 `buildStandardCommand` 的 `effortFlag` 挂;ACP 腿由宿主的 `copilot-provider-env` 方言
 * 物化器产出、经平台 adapter-env 信封挂到 `copilot --acp` —— 同一个旗标。
 *
 * ACP 腿实测 #6218(copilot 1.0.88,本地假端点):`copilot --acp --effort low` → `POST /v1/responses`
 * 带 `reasoning:{effort:"low"}`;不带 → `reasoning:{}`;`session/set_config_option reasoning_effort`
 * 对自定义 provider 模型被拒(「The selected model does not support reasoning_effort configuration.」)。
 */
export const COPILOT_EFFORT_FLAG = '--effort';

/**
 * 把咕咕的自治档位落成 copilot 的 argv。**两条腿共用**。
 *
 * 咕咕只建模两档（`SessionAutonomyCapability.mode`），所以这里只映射这两档：
 *  · `full-access`       → `--allow-all-tools`（官方原文「Allow all tools to run
 *    automatically without confirmation; required for non-interactive mode」）
 *  · `approval-required` → **什么都不加**，用 copilot 的默认（逐次询问）。
 *    ACP 那条腿上这些询问会经 `session/request_permission` 回到人；TUI 腿上用户直接看到。
 *
 * ❌ 这里**不碰**路径边界与沙箱（`--add-dir` / `--allow-all-paths` / `--sandbox`）。
 *    copilot 默认就把文件访问限制在 cwd 及其子目录 + 系统临时目录（官方 `help permissions`
 *    原文），那已经是个合理的地板；咕咕当前的 autonomy 模型只有「要不要逐次确认」这一个轴，
 *    把路径/网络硬塞进这两档等于替用户做了他没表达过的决定。要建模那些轴，先扩 autonomy 类型。
 *
 * ⚠️ 别指望用 `--allow-all-tools` 覆盖掉别处的拒绝规则:官方 `help permissions` 逐字
 *    「Denial rules always take precedence over allow rules, even --allow-all-tools」。
 */
function autonomyArgs(bundle: SessionCapabilityBundle): string[] {
  if (!bundle.autonomy) return [];
  return bundle.autonomy.mode === 'full-access' ? ['--allow-all-tools'] : [];
}

/**
 * 交给子进程的会话环境 —— **按前缀白名单**，❌ 不是「整份减掉几个」。
 *
 * 为什么是白名单而不是黑名单：`bundle.env` 里带着宿主转发的 provider 凭据
 * （`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 等，那是给 BYOK 用的）。**copilot 一个都不读** ——
 * 它的 provider 配置走 `COPILOT_PROVIDER_*`。而这一家给子进程的是「全量父环境减一张黑名单」，
 * 所以交给它的任何东西都会到达 agent 之后启动的**每一个** bash 命令、MCP server、
 * LSP server、扩展和 hook。把一把它根本用不上的密钥递过去 = 纯暴露、零收益。
 *
 * 白名单是两条前缀：
 *  · `GUGU_` —— 咕咕自己的会话变量，本维要投递的就是这些
 *  · `COPILOT_` —— 这一家自己的配置（模型那维产出的 `COPILOT_PROVIDER_*` 也在此列）
 *
 * ❌ 别改成「黑名单剔掉别家凭据」：那张名单在宿主那一侧（`ENGINE_ENV_ALLOWLIST`），
 *    它加一个键而这里不跟，就会静默多转发一把密钥 —— 失效方向是**放行**。前缀白名单反过来，
 *    漂移的后果是少给一个变量。
 *
 * ⚠️ **代价说在明处**：不匹配这两条前缀的变量会被丢掉，而且不报错。所以
 *    「我给 copilot 会话加了个环境变量，它读不到」的答案就在这里 —— 要么把变量命名成
 *    `GUGU_` 前缀（咕咕自己的会话变量本来就该这么命名），要么在下面这个常量里加一条前缀
 *    并写明理由。`COPILOT_SESSION_ENV_PREFIXES` 的单测钉住了「哪些进、哪些不进」，
 *    改这个常量会当场看到那条用例变化。
 *
 * ⚠️ MCP 的授权变量落在 `GUGU_` 前缀里,**两条腿的答案不同**:ACP 腿上它已经进了
 *    `session/new` 的请求头,env 里再留一份只有暴露面 ⇒ 剔掉;TUI 腿上它是会话 MCP 配置里
 *    `${VAR}` 占位符的**唯一取值来源**(copilot 只在 headers 里做 env 展开,实测见
 *    sessionMcpDelivery 抬头)⇒ 必须留下,否则 Authorization 永远是一个没着落的字面串。
 */
const COPILOT_SESSION_ENV_PREFIXES = ['GUGU_', 'COPILOT_'] as const;

function sessionEnv(
  bundle: SessionCapabilityBundle,
  opts: { keepMcpAuthorization: boolean }
): Record<string, string> {
  const authorizationEnv = new Set(
    bundle.mcpServers.flatMap((server) =>
      server.transport !== 'stdio' && server.authorizationEnv ? [server.authorizationEnv] : [])
  );
  return Object.fromEntries(
    Object.entries(bundle.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined
        && (opts.keepMcpAuthorization || !authorizationEnv.has(entry[0]))
        && COPILOT_SESSION_ENV_PREFIXES.some((prefix) => entry[0].startsWith(prefix))
    )
  );
}

const promptKeys = ['platform', 'identity'] as const;

/** 这个变量承载的是**目录列表**,不是一份文件。 */
const COPILOT_INSTRUCTIONS_DIRS_ENV = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS';
/**
 * ⚠️ `.instructions.md` 这个后缀是**判据本身**,不是命名品味:同一个目录里的 `AGENTS.md`
 *    实测一次都不进系统提示(0/6,复跑两次),尽管官方文档说这个变量收 AGENTS.md。见 units.promptBlocks。
 */
const COPILOT_INSTRUCTIONS_FILE = 'gugu-session.instructions.md';

function instructionsDir(bundle: SessionCapabilityBundle): string {
  return join(sessionRunHome(bundle, 'Copilot', 'copilot-capability-runs'), 'instructions');
}

type InstructionsDelivery = {
  artifact: GeneratedArtifact;
  dirs: string;
  delivered: (typeof promptKeys)[number][];
};

/** 会话级 MCP 配置文件在 `--additional-mcp-config` 上的指针形态(`@` 前缀 = 文件路径)。 */
const SESSION_MCP_CONFIG_FILE = 'session-mcp-config.json';

type SessionMcpDelivery = {
  artifact: GeneratedArtifact;
  args: [string, string];
};

/**
 * 把本会话的 gugu MCP server 落成 copilot 真吃的那份会话级配置 —— run-scoped 文件 +
 * `--additional-mcp-config @<路径>`。声明与实测出处见 descriptor 的 units.mcp 注释。
 *
 * ⚠️ **占位符展开的边界是实测出来的,两格答案不同**(mac1,copilot 1.0.82,2026-09-01):
 *    · `headers` 里的 `${VAR}` **会**从进程环境展开(占位 Authorization → 收点收到展开值);
 *    · `url` 里的 `${VAR}` **不会** —— 字面串直接撞 URL 校验,fail loud `Invalid url`,0 连接。
 *    ⇒ Authorization 走占位符 + child env(真值不进 artifact/argv,守 session-capability-contract
 *    的 secret 红线;env 暴露形状与 qwen TUI 同形,是已接受的先例);url 写字面值 —— 它不是
 *    secret,且文件 run-scoped 随目录消亡,没有「残留指旧端口」的问题。
 * ⚠️ 声明了 authorizationEnv 却拿不到值 = 配置残缺,fail loud,❌ 静默发一个占位符
 *    没着落的条目(copilot 对 undefined 变量的展开行为未测,不赌)。
 * ⚠️ `tools: ['*']` 与 copilotMcpAdapter 的写形一致 —— 缺这格 copilot 只启用它自己的
 *    默认工具子集。
 */
function sessionMcpDelivery(bundle: SessionCapabilityBundle): SessionMcpDelivery | null {
  if (bundle.mcpServers.length === 0) return null;
  const servers = Object.fromEntries(
    bundle.mcpServers.map((server) => {
      if (server.transport === 'stdio') {
        assertSessionMcpStdioEnv(server, bundle, 'Copilot');
        return [server.name, { ...sessionMcpStdioConfig(server), tools: ['*'] }];
      }
      sessionMcpAuthorization(server, bundle.env, 'Copilot');
      return [server.name, {
        type: 'http' as const,
        url: server.url,
        ...(server.authorizationEnv
          ? { headers: { Authorization: `\${${server.authorizationEnv}}` } }
          : {}),
        tools: ['*'],
      }];
    })
  );
  const path = join(sessionRunHome(bundle, 'Copilot', 'copilot-capability-runs'), 'session-mcp', SESSION_MCP_CONFIG_FILE);
  return {
    artifact: { path, content: JSON.stringify({ mcpServers: servers }, null, 2), mode: 0o600 as const },
    args: ['--additional-mcp-config', `@${path}`],
  };
}

/**
 * 把平台自述 + 身份自述落成一份 copilot 真会读的指令文件。
 *
 * ⚠️ 一个块都没有时返回 `null` —— **一个字都不发**。写个空文件再把变量指过去,是往用户的
 *    会话里塞一个咕咕自己并不需要的配置面。
 */
function instructionsDelivery(bundle: SessionCapabilityBundle): InstructionsDelivery | null {
  const delivered = promptKeys.filter((key) => Boolean(bundle.promptBlocks[key]));
  const value = delivered.map((key) => bundle.promptBlocks[key]).join('');
  if (!value) return null;
  const dir = instructionsDir(bundle);
  // ⚠️ **追加**不覆盖:这个变量是逗号分隔的列表,每个目录都会被读(实测两目录各命中 6/6)。
  //    覆盖等于把调用方已经指过的目录静默丢掉 —— 今天宿主的 allowlist 里没有这个键,所以
  //    实际上取不到值;写成追加是为了那张名单以后加了这一条时不会变成一次静默的回归。
  const existing = bundle.env[COPILOT_INSTRUCTIONS_DIRS_ENV]?.trim();
  return {
    // ⚠️ 0600:这段自述里有这个 agent 的咕咕身份。
    artifact: { path: join(dir, COPILOT_INSTRUCTIONS_FILE), content: value, mode: 0o600 as const },
    dirs: existing ? `${existing},${dir}` : dir,
    delivered,
  };
}

function promptReport(delivery: InstructionsDelivery | null) {
  return delivery
    ? { status: 'loaded' as const }
    : {
        status: 'degraded' as const,
        reason: { code: 'unverified' as const, reason: 'No prompt blocks were declared.' },
      };
}

function materializeSessionTui(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const degraded = (reason: Degradation) => ({ status: 'degraded' as const, reason });
  const env = sessionEnv(bundle, { keepMcpAuthorization: true });
  applyModelEnv(bundle, env);
  // 两条腿共用同一条指令通道:同一个二进制、同一个进程环境,argv 在这里可用但用不着。
  const instructions = instructionsDelivery(bundle);
  if (instructions) env[COPILOT_INSTRUCTIONS_DIRS_ENV] = instructions.dirs;
  // 会话级 MCP:run-scoped 文件 + `--additional-mcp-config @<路径>`(#4657 层4,出处见 descriptor)。
  const sessionMcp = sessionMcpDelivery(bundle);

  return {
    argsAppend: [...autonomyArgs(bundle), ...(sessionMcp ? sessionMcp.args : [])],
    env,
    configMerges: [],
    artifacts: [
      ...(instructions ? [instructions.artifact] : []),
      ...(sessionMcp ? [sessionMcp.artifact] : []),
    ],
    report: {
      adapterId: 'copilot',
      surface: ctx.surface,
      units: {
        mcp: sessionMcp
          ? { status: 'loaded' as const }
          : degraded({ code: 'unverified', reason: 'No MCP servers were declared.' }),
        env: { status: 'loaded' as const },
        // ⚠️ 判据是 `COPILOT_PROVIDER_MODEL_ID` 这一格，❌ 不是 `Object.keys(env).length > 0`：
        //    env 这一维接通之后 env 几乎总是非空，那个旧判据会把「没选模型」也报成 loaded。
        model: env.COPILOT_PROVIDER_MODEL_ID !== undefined
          ? { status: 'loaded' as const }
          : degraded({ code: 'unverified', reason: 'No model was declared.' }),
        autonomy: bundle.autonomy
          ? { status: 'loaded' as const }
          : degraded({ code: 'unverified', reason: 'No autonomy was declared.' }),
        promptBlocks: promptReport(instructions),
        packages: degraded(copilotSessionBundleDescriptor.extension.degraded),
      },
      discoveredCommands: [],
    },
  };
}

function materializeSessionAcp(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  // 这里原先只放行 MCP 的授权变量、其余一概丢弃 —— 那是 `units.env` 还声明成 `none` 时
  // 「没声明的就别投递」的做法。这一维接通后整份会话环境都要交出去；通用物化会在用完
  // 授权变量拼出请求头之后把它们从 env 里删掉，所以令牌仍然不进子进程。
  // ⚠️ 交给通用物化的是**过完筛子**的 env：它会把 `bundle.env` 整份交出去，
  //    而这一家不该拿到别家的 provider 凭据（理由见 `sessionEnv`）。
  //    授权变量在这里仍要保留 —— 通用物化用它拼 `session/new` 的请求头，用完自己会删。
  const authorizationEnv = new Set(
    bundle.mcpServers.flatMap((server) =>
      server.transport !== 'stdio' && server.authorizationEnv ? [server.authorizationEnv] : [])
  );
  const scopedBundle = {
    ...bundle,
    env: Object.fromEntries(
      Object.entries(bundle.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined
          && (authorizationEnv.has(entry[0])
            || COPILOT_SESSION_ENV_PREFIXES.some((prefix) => entry[0].startsWith(prefix)))
      )
    ),
  };
  const result = materializeAcpSessionBundle(
    'copilot',
    copilotSessionBundleDescriptor,
    ctx,
    scopedBundle
  );
  const env = { ...result.env };
  applyModelEnv(bundle, env);
  const modelDelivered = env.COPILOT_PROVIDER_MODEL_ID !== undefined;
  // ❌ 这里**不再**产出 `materialization.prompt`。那条腿的落点是 `session/new` 的
  // `_meta.systemPrompt.append`,而 copilot 实测收下即丢(0/6,见 units.promptBlocks 的读数)——
  // 继续发等于把一份没人读的载荷当成「已投递」上报。改走它真读的那条:文件 + 目录变量。
  const instructions = instructionsDelivery(bundle);
  if (instructions) env[COPILOT_INSTRUCTIONS_DIRS_ENV] = instructions.dirs;

  return {
    ...result,
    env,
    // ❌ 自治档不上 ACP 腿的 argv(`result.argsAppend` 原样,不叠 `autonomyArgs`):这条腿的审批一直经
    //    `session/request_permission` 回到咕咕,`--allow-all-tools` 一旦挂上,copilot 就不再询问,而活会话
    //    里降档到不了进程(无 liveSettings)。这一维该走哪条通道、报告怎么如实写,另见 #6234。
    artifacts: [...result.artifacts, ...(instructions ? [instructions.artifact] : [])],
    report: {
      ...result.report,
      units: {
        ...result.report.units,
        autonomy: bundle.autonomy
          ? { status: 'loaded' as const }
          : { status: 'degraded' as const, reason: { code: 'unverified' as const, reason: 'No autonomy was declared.' } },
        model: modelDelivered
          ? { status: 'loaded' as const }
          : { status: 'degraded' as const, reason: { code: 'unverified' as const, reason: 'No model was declared.' } },
        promptBlocks: promptReport(instructions),
      },
    },
  };
}

export function materializeCopilotSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface === 'tui') return materializeSessionTui(ctx, bundle);
  return materializeSessionAcp(ctx, bundle);
}
