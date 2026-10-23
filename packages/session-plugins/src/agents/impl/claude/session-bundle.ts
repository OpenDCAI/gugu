import { harnessPlatform } from './platform';
import {
  createHash,
} from 'node:crypto';
import {
  join,
} from 'node:path';
import type {
  CapabilityPackage,
  GeneratedArtifact,
  GeneratedSymlink,
  NativeHome,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionMcpServer,
  SessionPromptBlocks,
} from '@gugu/session-core/agents/plugins';
import { extensionSkillFolderName } from '@gugu/session-core/agents/plugins';
import { claudePlatformModelOption } from '@gugu/session-core/acp/platform-model-address';
import { mcpToggleDirective, type McpToggleServer } from '@gugu/session-core/mcp';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
} from '../../helpers/session-mcp';

export const CLAUDE_GUGU_PACKAGE_ID = 'gugu-product';
export const CLAUDE_GUGU_PACKAGE_VERSION = '1.0.0';
/**
 * 资源库 → MCP 带上的那几台(用户自己的 server,经咕咕送)单独装进这个插件,❌ 装进 `gugu-product`。
 * 工具名于是是 `mcp__plugin_mcp-library_<server>__<tool>`,和用户自己装的插件同形;装在咕咕品牌的插件里时,
 * GLM-5.3 在 Claude 终端腿上每次都把 `gugu-product_` 那一段「纠正」掉,调不到(10-18 mac1 抓包)。
 * 名字取中性的一个;用户自己装了一个同名插件的话,两份会在 Claude 里撞 —— 实测前没见过,记在这里。
 */
export const CLAUDE_LIBRARY_PLUGIN_ID = 'mcp-library';

/** 这一台在 Claude 里装在哪个插件里(工具名的前缀跟着它)。 */
const pluginIdOf = (server: SessionMcpServer): string => (server.library ? CLAUDE_LIBRARY_PLUGIN_ID : CLAUDE_GUGU_PACKAGE_ID);

const pluginManifest = {
  name: CLAUDE_GUGU_PACKAGE_ID,
  version: CLAUDE_GUGU_PACKAGE_VERSION,
  description: 'Gugu product capabilities and their audit manifest.',
  author: { name: 'Gugu Team' },
};


const capabilityAudit = {
  schemaVersion: 1,
  adapterId: 'claude',
  surfaces: ['acp', 'tui'],
  units: ['mcp', 'env', 'model', 'promptBlocks', 'packages'],
  dynamicReferences: ['mcp.url', 'mcp.authorizationEnv', 'env', 'model'],
};

export const CLAUDE_GUGU_CAPABILITY_PACKAGE: CapabilityPackage = {
  id: CLAUDE_GUGU_PACKAGE_ID,
  version: CLAUDE_GUGU_PACKAGE_VERSION,
  artifacts: [
    {
      path: '.claude-plugin/plugin.json',
      content: `${JSON.stringify(pluginManifest, null, 2)}\n`,
      mode: 0o644,
    },
    {
      path: 'gugu-capabilities.json',
      content: `${JSON.stringify(capabilityAudit, null, 2)}\n`,
      mode: 0o644,
    },
  ],
};

export const CLAUDE_NATIVE_HOME = {
  envVar: 'CLAUDE_CONFIG_DIR',
  userPath: '.claude',
  evidence: 'code.claude.com/docs/en/settings 环境变量表 CLAUDE_CONFIG_DIR;默认 ~/.claude',
} as const satisfies NativeHome;

export const claudeSessionBundleDescriptor = {
  // 运行时注入(product spec 的默认那一侧)。owner 2026-09-03:
  // 「claude 配置不需要托管,也不应该托管」。#4834 留下的举证在 #4780 之后补完了:
  //  · 模型 / 中转 / agent view 禁用:每会话 `--settings` 临时文档(sessionpage-platform-model.ts)。
  //  · MCP / 能力包:每会话 `--plugin-dir`(下面 extension.activation = 'session-dir')。
  //  · 首启向导 + 工作区信任:`IS_DEMO=1` + `CLAUDE_CODE_SANDBOXED=1` 两个 env,二进制里逐条
  //    取证见 ./trust.ts —— 托管侧当年要写 `.claude.json` 只为这两位,现在有 env 通道了。
  //  · bypass 免责声明:settings 键 `skipDangerousModePermissionPrompt`(同一份 --settings 文档)。
  // 托管那一侧对本家只剩代价:整树复制 `~/.claude`(实测 813 MB)、凭据一式两份各自过期
  // (owner 实机撞到的「Authentication required」),而 `.claude.json` 本就住在家目录根、
  // 托管副本够不着。⇒ 用户的 `~/.claude` 就是会话的 `~/.claude`,咕咕不复制、不改写。
  injectionMode: 'runtime',
  nativeHome: CLAUDE_NATIVE_HOME,
  platform: harnessPlatform,
  // ❌ `IS_DEMO` / `CLAUDE_CODE_SANDBOXED` 是咕咕给 claude 的工作区信任通道(./trust.ts),必须成对由 WorkspaceTrustService 给出 ——
  // 曾经只透传 IS_DEMO(#2905),用户 shell 里碰巧 export 了它,claude 跳过信任对话框而工作区仍不可信。
  // `CLAUDE_PROJECT_DIR` 是 claude 每次调用按当前项目填给钩子用的,shell 里的残留值会把钩子指到另一个项目。
  shellEnv: {
    passThrough: [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CONFIG_DIR',
    ],
    denied: ['CLAUDE_CODE_SANDBOXED', 'CLAUDE_PROJECT_DIR', 'IS_DEMO'],
  },
  /**
   * 关自更新(#6186)。官方开关就是 env,且两条腿都够得着:终端腿直起 claude,协议腿的适配器把
   * 宿主 env 原样传给它拉起的 claude —— 适配器读不到咕咕的 settings,只能走 env。
   * 只关**后台**自更新;用户在会话里亲手 `claude update` 仍然是他自己的动作。
   */
  selfUpdate: {
    kind: 'session-env',
    env: { DISABLE_AUTOUPDATER: '1' },
    evidence:
      'https://code.claude.com/docs/en/setup#auto-updates「Set DISABLE_AUTOUPDATER … only stops the background check」;'
      + ' 2.1.267 发行二进制 strings 含 DISABLE_AUTOUPDATER。取证 2026-09-23',
  },
  credentialLifecycle: {
    'acp': {
      delivery: 'credential-helper',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
    'tui': {
      delivery: 'credential-helper',
      originalProcessRefresh: 'supported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: ['acp', 'tui'],
  /**
   * TUI 腿的中断键:单击 Esc。宿主(`ptyController.interrupt`)据此往 pty 写字节;手机端的「停止」
   * 走到终端腿就是这一条。ACP 腿的暂停仍是 `protocol-cancel`(考卷 tui-coexistence:双腿家的
   * 中断键由本字段记录,pause 不改)。
   * ⚠️ 不是 Ctrl+C:官方表里 Ctrl+C 在没有运行中操作时第二次按会**退出**;也不是 Esc Esc(清草稿 / 回溯)。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'https://code.claude.com/docs/en/interactive-mode#general-controls 「Esc | Interrupt Claude, or close a dialog |'
      + ' Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far」;'
      + ' 同表 Ctrl+C 条「If nothing is running, the first press clears the prompt input and a second press exits」;取证 2026-09-15',
  },
  /**
   * TUI 腿的 AskUserQuestion 选择器能从咕咕的提问卡回答(#6798、#7035):Esc 关掉选择器(agent 收到
   * 「User declined to answer questions」,本轮结束),再把回答当消息发过去。
   * 节拍:写完 Esc 等终端连续 20ms 没有新输出(重画完);2s 等不到就报错。
   */
  sessionTuiQuestionAnswer: {
    cancel: '\u001b',
    settleMs: 20,
    maxWaitMs: 2000,
    evidence:
      'https://code.claude.com/docs/en/interactive-mode#general-controls 「Esc | Interrupt Claude, or close a dialog」;'
      + ' Esc 关掉 AskUserQuestion 后记录里是「User declined to answer questions」、再发一条消息 agent 照答:'
      + ' 实测 Claude Code 2.1.293,11/11;取证 2026-10-09',
  },
  /**
   * spec `mcp-session-toggle` —— claude 怎么在会话级关掉 MCP server。
   *
   * `disallowed-tools`:claude 自己的 `disallowedTools`,一台 server 一条 `mcp__<名>`(插件投递的是
   * `mcp__plugin_<包>_<名>`),摘掉那一台的全部工具;claude 照常自己解析它的每一层配置。
   * 实测(2026-10-07,mac1,Claude Code 2.1.267,假端点读真实请求里的工具名;用户级 / 本地级 / 项目级各一台):
   *  · 不关:三台的工具都在(阳控);
   *  · 关用户级那台:只少它;关本地级那台:只少它 —— 其余两层都在。
   *  · 被关的那台进程照样起(claude 后台连接,坏的那台也拖不住启动),只是模型看不到它的工具。
   * 适配器把 `_meta.claudeCode.options.disallowedTools` 与它自己的那份**合并**(@gugu-acp/claude-agent-acp 1.1.2 dist:
   * `[...userProvidedOptions.disallowedTools, ...disallowedTools]`),❌ 不覆盖。
   *
   * ⚠️ 这里从前是 `authoritative-list`(strict:忽略一切文件来源,咕咕递回完整清单)。咕咕读不到的层
   *    (本地级、项目级、用户装的插件)在 strict 下一律丢掉 —— 关一台,悄悄丢三台(10-07 资源库体检实测)。
   */
  mcpToggle: { dialect: 'disallowed-tools', granularity: 'per-server' },
  /**
   * 终端腿的版本地板 —— 这条腿的系统提示靠 `--append-system-prompt-file`(见 `tuiPromptFile`)。
   *
   * 要防的失败模式不是「老版不认这个 flag」(那种会以 `unknown option` 响亮死在启动),而是
   * **认了却不在交互模式里兑现**:上游文档一度写它「print mode only」,真那样的版本会让每条终端会话
   * 静默丢掉平台块与身份块,而界面上一切正常。⇒ 地板取一个**量过**的版本,低于它就在 spawn 前说人话。
   *
   * 2.1.69 的依据:上游 CHANGELOG 在这一版写明这两个 `-file` flag「work in interactive mode
   * (the docs previously said print mode only)」;实测(2026-09-21,npm 装的 2.1.69,pty 驱动交互 TUI,
   * 本地假端点读**真实上行请求**的 `system` 段,口令只写在提示档里):不给 flag ⇒ system 15313 字符、
   * 无口令(阴控);给 flag ⇒ 15468 字符(恰好 +155 = 提示档长度)、有口令。同一把尺子在 2.1.278 上
   * 双向成立。更低的版本**没量过**,不是「已知不行」—— 要下移地板,先用同一把尺子量。
   * 协议腿不设:它的系统提示走 SDK 的 initialize,不经这个 flag。
   */
  runtimeCompatibility: {
    'tui': {
      kind: 'semver-supported-floor',
      supportedFloor: '2.1.69',
      versionArgs: ['--version'],
    },
  },
  sessionpage: {
    // acp messages use the ACP runtime prompt path so every turn is owned by the ACP cell.
    // Claude's rendezvous socket remains the native session-TUI channel only; its session-ACP bypass
    // caused session_spawn turns to disappear from in-memory history (#4949). Claude ACP 0.75.1
    // advertises and implements `_session/steering`; the runtime negotiates that capability and
    // uses promptRequired for the exact turn-boundary race.
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence: 'agentclientprotocol/claude-agent-acp@3e23c5b960b6 src/acp-agent.ts:426-431 (0.75.1): the `_session/steering` '
          + 'extension injects a message into the in-flight turn. Claude Code acp busy-session product reading with that adapter, 2026-09-11.',
        deviations: 'ACP steering uses `_session/steering` with idleBehavior promptRequired; a boundary race falls back to one standard session/prompt. Rendezvous remains TUI-only.',
      },
    },
    // rendezvous 腿:送达三态是本 adapter 的内部纪律,不进内核契约。
    'tui': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence: 'shuxueshuxue/spexcode@e49ba3e7e551 spec-cli/src/harness.ts:429-435(Claude Code 自带的 rendezvous 控制 socket:'
          + 'CLAUDE_BG_BACKEND=daemon + CLAUDE_BG_RENDEZVOUS_SOCK,写一行 reply 即作为输入交给活着的会话);'
          + 'claude/TUI F1R3 【产品】读数(2026-08-31)——聊天页建 agent(surface=tui)→云收件箱→rendezvous socket,暗号 A=11:06:55.473Z 于 sleep90 工具边界(tool_result 11:08:24.370/queue remove .373,#636 队列机制)进模型,逐字 ACK 744652df 11:08:31.941 在首轮内、单 end_turn B=11:08:48.031,PRE/POST 阳控双过；tip 843a6d982c 同形确认。',
        // ⚠️ 按 ingress 记,❌ 不是"claude 这家如此":同一二进制三条 ingress(#4482
        // comment-5464690093)。R15/#4482 曾读出 rendezvous「落下一轮」,与本格 F1R3 的
        // next-tool-call 不是矛盾读数,而是 #636 队列机制的两面(督导裁定,已写入 #4500):
        // 暗号在忙时入队,在**下一个工具边界**出队注入 —— 当前轮**还有**后续工具边界(如
        // F1R3 的 sleep90→tool_result)则同轮 next-tool-call;当前轮**没有**further boundary
        // (模型正要 end_turn)才落到下一轮。产品投递路(rendezvous)实测命中前者。
        deviations: 'rendezvous ingress,#636 队列在下一工具边界出队注入。当前轮有后续边界⇒同轮(F1R3 实测);无边界⇒落下一轮——两面同机制(#4500 已收)。此前 R15/#4482 据「落下一轮」拟「待降档 idle-only」的判读已撤:那读的是无-further-boundary 分支,产品路命中有-boundary 分支。',
      },
    },
  },
  units: {
    mcp: { kind: 'native', channel: 'plugin-manifest' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'native', channel: 'session-config' },
    autonomy: {
      kind: 'none',
      degraded: {
        code: 'unsupported-channel',
        reason: 'Claude autonomy is selected by the host permission channel, outside this bundle.',
      },
    },
    // 系统提示 —— 两条腿同坐**系统位**(behavior `agent-context-injection` 的 ②),只是运输不同。
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        // 协议腿:宿主落成 `session/new` 的 `_meta.systemPrompt.append`,SDK 经 stdin 的
        // initialize 递给 claude —— 一个字都不上 argv(真机读数:整条命令行 376 字节)。
        'acp': { kind: 'native', channel: 'system-meta' },
        // 终端腿:提示档落在咕咕自己的目录,argv 上只有 `--append-system-prompt-file <路径>`。
        // 落点、出处与「为什么正文不上 argv」见 `tuiPromptFile` 抬头。
        'tui': { kind: 'native', channel: 'prompt-file-argv' },
      },
    },
  },
  extension: {
    kind: 'declarative-bundle',
    format: 'claude',
    activation: 'session-dir',
    carries: { mcp: 'manifest', skills: 'manifest', hooks: 'none' },
  },
  coexistence: {
    // ACP 腿(surfaces 含 'acp')带来的两条,与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /**
     * 读 agent 的 todo / plan —— **接通**,通道是 ACP 的结构化 `plan` 更新。
     *
     * ⚠️ 这一条是**推翻**上一版的读数,不是补声明。上一版落回基类,理由是「唯一那份真机录像
     * `fixtures/acp-transcript.json` 里 0 条 plan session update」。那个理由本身没错(现在数还是 0),
     * 错在把它当成了判据:那份录像 `meta.generatedAt` 是 2026-07-03,当时跑的是旧版弱提示,
     * 整场里 `TodoWrite` 一次都没被调用(全文 grep `TodoWrite` = 0 次)——
     * **「没录到」不是「不转发」**,正是「失败仪器的空输出不是阴性读数」那条。
     *
     * 现在有比录像更硬的出处:桥的**源码**,而且钉的正是根 package.json 里那一版
     * (`@agentclientprotocol/claude-agent-acp` 0.54.1)。
     * ⚠️ 仓库身份要说清:`zed-industries/claude-code-acp` 已改名/迁移,今天的真身是
     * `agentclientprotocol/claude-agent-acp`(两个 `gh api repos/...` 返回同一份 payload、
     * 同一个 `created_at`)。npm 上 0.54.1 的 `gitHead` = 15ec9ab0dcd79b417674b11748bfeace629c085d,
     * 该 sha 的 package.json `"version": "0.54.1"` 对得上。
     *
     * `agentclientprotocol/claude-agent-acp@15ec9ab0dcd79b417674b11748bfeace629c085d`
     * `src/acp-agent.ts` 里**四个** `sessionUpdate: "plan"` 发射点:
     *  · :4632 —— `chunk.name === "TodoWrite"` 且 `Array.isArray(chunk.input?.todos)` 时发
     *    `{ sessionUpdate: "plan", entries: planEntries(chunk.input) }`;
     *  · :4756 —— `Task*` 工具在 tool_result 时发 `entries: taskStateToPlanEntries(sessionState)`;
     *  · :3398 / :3417 —— 建会话时注册的 `TaskCreated` / `TaskCompleted` hook,各自再发一次快照。
     * :4478-4485 的注释把两条路的关系写死了:「TodoWrite is rendered as a `plan` and Task* tools
     * are suppressed (their plan snapshot is emitted at tool_result time)」——
     * 所以它**不是** codex 那种「映射成 agent_thought_chunk」的截断,plan 是一等公民。
     *
     * ⚠️ 两条路都要留着,因为 `TodoWrite` 已经**默认禁**了:官方工具表原文
     * (https://code.claude.com/docs/en/tools-reference)「`TodoWrite` — Manages the session task
     * checklist. Disabled by default in favor of `TaskCreate`, `TaskGet`, `TaskList`, and
     * `TaskUpdate`」。桥的 :4466-4470 注释对上了这一点:「Headless/SDK sessions use these instead
     * of TodoWrite」。新老引擎各走一条,落到咕咕这边都是同一个 `plan`。
     *
     * 咕咕这一侧接得住,且不分家:`session-core/src/acp/transport/decode.ts` 解出
     * `{ kind: 'plan', entries }`,`normalized-event.ts` 归一成结构化 entries(❌ 不是纯 markdown)。
     */
    todo: { kind: 'native', channel: 'acp-plan' },
    // ⚠️ 下面两条**不是**照「surfaces 含 acp 就该有」推出来的 —— claude 的 ACP 腿不是厂商
    // 自己的 ACP server,而是第三方 npm 包 `@agentclientprotocol/claude-agent-acp`(根
    // package.json 钉 0.54.1;index.ts:46 解析入口,:249 起 spawn 它、用 CLAUDE_CODE_EXECUTABLE
    // 指向宿主 claude)。桥会不会把某条截断必须逐条核 —— codex 那座桥就是被截断的反例。
    // 判据取自本目录的真机录像 fixtures/acp-transcript.json(meta.generatedAt 2026-07-03):
    //  · 273 条 session/update + 12 组 prompt→stopReason 往返。session/update 经
    //    agent-ports/agent-client.ts:53 → runtime/session-manager.ts:612 → session/cell.ts:182
    //    的 push 喂进会话机,machine/machine.ts:410 的 projectSessionState 产出
    //    isGenerating(:414/:423)与 canCancel(:425) —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    observability: { kind: 'native', channel: 'acp-update' },
    //  · 录像 seq 183 / 247 是两条 permission_request:桥**主动发**了带 id 的
    //    `session/request_permission`,三档 options(allow_always / allow / reject)出去,
    //    resolvedOptionId 回来 —— 「带 options 出去、点选回来」的往返在这条腿上确实存在,
    //    ❌ 不是单向通知。咕咕这一侧的装配不分家:agent-client.ts:57 →
    //    session-manager.ts:641 → cell.ts:318 落进 pendingPermissions →
    //    session-chat-ui/src/state/chat-state.ts:364 摆到界面 → cell.ts:299 由人点选回填。
    // ❌ 不是澄清型的 mcp-elicitation / native-tool:咕咕没有那条路。
    askUser: { kind: 'native', channel: 'permission-ask' },
    // 咕咕接通的读回路径:core 的 `transcriptSources/claudeCode.ts` 声明扫 ~/.claude/projects
    // (或 CLAUDE_CONFIG_DIR)下的 *.jsonl,通用层(transcriptInventory.ts)按这份 spec 解析成轮次。
    // ⚠️ 判据是「core 的注册表里有没有它那一份 spec」,不是「厂商有没有本地历史」——
    // 全仓当前只接了 claude-code 与 codex 两家,别照抄给别家。
    // 两侧由 tests/unit/core/local/transcriptSources.test.ts 双向对账(声明⇔接通)。
    history: { kind: 'native', channel: 'jsonl' },
    // claudeMcpAdapter(impl/claude/mcp-scopes.ts)的 readServers / readScopedServers 报出的是
    // **用户自己写的** mcpServers,不启引擎。
    // ⚠️ hooks 不算:buildNestedJsonHookConfig.readHooks 只回答「咕咕注的那几条在不在」
    //    (命中就返回一个 GUGU_HOOK_MARKER),它从不枚举用户自己的 hook。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 咕咕经 `AgentPluginHost.readMemoryFiles`(session-core/.../plugin-host.ts:270)读得到 claude
    // 自己会去读的 CLAUDE.md 一族 —— 具体登记在 `impl/claude/index.ts` 的 `capabilities.memory`,
    // 通道 `vendor-file`(CLAUDE.md 是 claude 的专名文件;官方文档同页明写
    // 「Claude Code reads `CLAUDE.md`, not `AGENTS.md`」,所以 ❌ 不是 agents-md)。
    // 厂商出处:https://code.claude.com/docs/en/memory
    // ⚠️ 两处必须同通道。
    memory: { kind: 'native', channel: 'vendor-file' },
    // cron 落回基类:咕咕这边找不到接通的证据。
  },
} satisfies SessionBundleDescriptor;

function renderPromptBlocks(blocks: SessionPromptBlocks): string {
  return (blocks.platform ?? '') + (blocks.identity ?? '');
}

function deliveredPromptBlocks(blocks: SessionPromptBlocks): (keyof SessionPromptBlocks)[] {
  return (['platform', 'identity'] as const).filter((key) => Boolean(blocks[key]));
}

/**
 * 终端腿的系统提示载体 —— 正文落盘,argv 上**只有一条路径**。
 *
 * 为什么正文不上 argv:argv 是一根**有界**的管子,而它的界不由咕咕定 —— 由咕咕与最终那个
 * claude 进程之间的**每一跳**共同决定。咕咕自己 spawn 的那一跳是 CreateProcess 的 32767;
 * 但用户把 Claude Code 的启动方式换成一个启动器(CLI 覆盖)之后,后面的跳就在别人的进程里了。
 * 2026-09-21 Windows 真机(owner 的 Beta,启动方式 = `reclaude`):`reclaude.exe` 按 PATH 再去找
 * `claude`,而咕咕给每棵 agent 进程树的 PATH **第 1 位**是自己的 `<GUGU_HOME>/agents/mise-bin`
 * (`managed-agent-home.ts`:「解析时排第一」),Windows 上那里面躺的是咕咕装 claude 时写下的
 * `claude.cmd` 垫片 ⇒ 那一跳由 cmd.exe 执行 ⇒ 上限 8191,而平台块一个参数就 10~14 KB ⇒
 * 终端里只有一句不指名的 `The command line is too long.`(同一条参数:7000 过、9000 起必炸;
 * 直起 `claude.exe` 30000 也过)。⚠️ 这一跳**是咕咕自己放的**,与用户机器上有没有原生 `claude.exe`
 * 无关 —— 单变量实测:PATH 第 1 位有没有 mise-bin,结果就在「必炸 / 通过」之间翻转。
 * npm 的 `claude.cmd`、用户自己写的 `.cmd` 启动器是同一类。
 * 咕咕「壳 → 壳里那个 .exe」的直起够不着别人进程里的跳;路径则每一跳都放得下,
 * 且长度与提示内容无关(#5852)。
 *
 * 出处(❌ 不是照文档推的):claude 2.1.278 二进制注册着
 * `--append-system-prompt-file <file>`(`Read system prompt from a file and append to the default
 * system prompt`;`--help` 只在 `--bare` 的说明里顺带提到它)。**交互 TUI** 实测(pty 驱动,口令只
 * 写在提示档里):不给 flag ⇒ 模型答 `NO-PASSPHRASE-KNOWN`(阴控);给 flag ⇒ 逐字答出口令。
 *
 * 落点:`GUGU_HOME` 下、按**正文指纹**命名。同一路径 ⇒ 同一份字节,所以并发会话互不覆盖
 * (与 `packageRoot` 同一条理由:这份字节按会话变,路径的粒度必须跟着内容走);同一个 agent
 * 反复开会话复用同一份档,数量以「不同正文的个数」为界。一条用户文件都不碰
 * (behavior `agent-config-boundary`:落在咕咕自己生成的路径上)。
 * ⚠️ 0600:这段自述里有这个 agent 的咕咕身份 —— 这也是它不该躺在 argv 上的另一条理由
 *    (argv 对本机每个进程可见)。
 */
function tuiPromptFile(bundle: SessionCapabilityBundle, value: string): GeneratedArtifact {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error('Claude session adapter requires bundle.env.GUGU_HOME');
  const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return {
    path: join(guguHome, 'capability-packages', 'claude', 'system-prompts', `${fingerprint}.md`),
    content: value,
    mode: 0o600,
  };
}

/**
 * 这一份 `.mcp.json` **按会话生成**,不再是一份写死的静态清单。
 *
 * 为什么必须生成:claude 的 TUI 腿只从这份插件清单里认 MCP server,而咕咕能给的那几台是
 * **随连随变**的 —— 用户在资源库里连上 Linear、Notion,清单就该多出那几台。写死一份的后果
 * owner 2026-09-15 实机撞到了:Linear 授权成功、集成页显示已连接,新开的会话里 agent 却说
 * 「没有任何 Linear 通道」。
 *
 * ❌ 只收 `owner !== 'user'` 的那几台:用户自己配置里的 server 由 claude 原生发现装载
 * (这条腿有意「保留用户原生发现」),再声明一遍就是同名重复加载。
 *
 * 值一律用 `${GUGU_SESSION_MCP_*}` 占位 —— 真地址与令牌由 `materializeMcpEnv` 放进子进程环境,
 * **不落盘**。
 */
function pluginMcpServersFor(bundle: SessionCapabilityBundle, library = false): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const server of bundle.mcpServers) {
    if (server.owner === 'user') continue;
    // 资源库那几台进 `mcp-library` 插件,其余进 `gugu-product`(见 CLAUDE_LIBRARY_PLUGIN_ID)。
    if (Boolean(server.library) !== library) continue;
    if (server.transport === 'stdio') {
      servers[server.name] = {
        type: 'stdio',
        command: server.command,
        args: [...(server.args ?? [])],
        env: Object.fromEntries(
          Object.entries(server.env ?? {}).map(([name, ref]) => [name, `\${${ref}}`])
        ),
        ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
      };
      continue;
    }
    servers[server.name] = {
      type: 'http',
      url: `\${${mcpUrlEnv(server.name)}}`,
      headers: { Authorization: `\${${mcpAuthEnv(server.name)}}` },
      alwaysLoad: true,
    };
  }
  return servers;
}

/**
 * 问题 9(owner 2026-09-28):咕咕发的 MCP server 在 Claude 会话里免审 —— 插件清单里那一整份
 * (`owner !== 'user'`),一台 server 一条规则,按插件名认。用户自己在 Claude 里配的不在这份里,不碰。
 */
function guguMcpAllowRules(bundle: SessionCapabilityBundle): string[] {
  return bundle.mcpServers
    .filter((server) => server.owner !== 'user')
    .map((server) => `mcp__plugin_${pluginIdOf(server)}_${server.name}`);
}

function pluginMcpConfigContent(bundle: SessionCapabilityBundle, library = false): string {
  return `${JSON.stringify({ mcpServers: pluginMcpServersFor(bundle, library) }, null, 2)}\n`;
}

/** 资源库那几台的插件:一份清单 + 一份 `.mcp.json`,目录按内容指纹分(和咕咕那个插件同一个理由)。 */
function libraryPlugin(bundle: SessionCapabilityBundle): { root: string; artifacts: GeneratedArtifact[] } | null {
  const content = pluginMcpConfigContent(bundle, true);
  if (Object.keys(pluginMcpServersFor(bundle, true)).length === 0) return null;
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error("Claude session adapter requires bundle.env.GUGU_HOME");
  const fingerprint = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const root = join(guguHome, 'capability-packages', 'claude', CLAUDE_LIBRARY_PLUGIN_ID, `${CLAUDE_GUGU_PACKAGE_VERSION}-${fingerprint}`);
  const manifest = { name: CLAUDE_LIBRARY_PLUGIN_ID, version: CLAUDE_GUGU_PACKAGE_VERSION, description: 'MCP servers picked from the library for this task.' };
  return {
    root,
    artifacts: [
      { path: join(root, '.claude-plugin/plugin.json'), content: `${JSON.stringify(manifest, null, 2)}\n`, mode: 0o644 },
      { path: join(root, '.mcp.json'), content, mode: 0o644 },
    ],
  };
}

function packageRoot(bundle: SessionCapabilityBundle): string {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) throw new Error("Claude session adapter requires bundle.env.GUGU_HOME");
  // 版本段后面挂一截**内容指纹**:这份包过去只按版本号落盘,于是同一个版本号的目录一旦生成
  // 就一直被复用 —— owner 2026-09-15 实机:早上 10:13 生成的那份目录,晚上起的每条会话还在用它,
  // 里面自然没有下午才连上的 Linear。指纹跟着清单内容走,连上/断开一家就是另一份目录,
  // 新开的会话自动拿到当下这份,❌ 不需要谁去清缓存。
  const fingerprint = createHash('sha256')
    .update(pluginMcpConfigContent(bundle))
    // 扩展带的 skill 也进指纹:装上/卸掉一个扩展就是另一份目录,卸掉的 skill 不会留在旧目录里被新会话看到。
    .update(JSON.stringify(extensionSkillLinks(bundle, '')))
    .digest('hex')
    .slice(0, 12);
  return join(
    guguHome,
    'capability-packages',
    'claude',
    CLAUDE_GUGU_PACKAGE_ID,
    `${CLAUDE_GUGU_PACKAGE_VERSION}-${fingerprint}`
  );
}

/**
 * #6387 Skills installed extensions bring, mounted into this session's plugin folder as
 * `skills/<extension>-<skill>` — Claude then lists them like its own (`gugu-product:<name>`), and reads
 * SKILL.md where the extension keeps it. Nothing is copied, nothing lands in the person's home.
 */
function extensionSkillLinks(bundle: SessionCapabilityBundle, root: string): GeneratedSymlink[] {
  return (bundle.extensionSkills ?? []).map((skill) => ({
    sourcePath: skill.dir,
    path: join(root, 'skills', extensionSkillFolderName(skill)),
    optionalSource: false,
  }));
}

function capabilityPackage(bundle: SessionCapabilityBundle): CapabilityPackage | undefined {
  const packageEntry = bundle.packages.find(
    (entry) =>
      entry.id === CLAUDE_GUGU_PACKAGE_ID && entry.version === CLAUDE_GUGU_PACKAGE_VERSION
  );
  if (!packageEntry && bundle.mcpServers.length > 0) {
    throw new Error(
      `Claude session adapter requires capability package '${CLAUDE_GUGU_PACKAGE_ID}@${CLAUDE_GUGU_PACKAGE_VERSION}'`
    );
  }
  return packageEntry;
}

function assertPackageDeclaresMcpServers(bundle: SessionCapabilityBundle): void {
  // 清单现在是生成的,所以这条断言守的是「生成器漏了一台」——它仍然是这条腿唯一的投递口,
  // 漏一台的症状是静默的(agent 只是少一组工具)。
  const declared = new Set([...Object.keys(pluginMcpServersFor(bundle)), ...Object.keys(pluginMcpServersFor(bundle, true))]);
  const missing = bundle.mcpServers
    .filter((server) => server.owner !== 'user')
    .map((server) => server.name)
    .filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Claude capability package '${CLAUDE_GUGU_PACKAGE_ID}@${CLAUDE_GUGU_PACKAGE_VERSION}' does not declare MCP server(s): ${missing.join(', ')}. Add them to the versioned static package before routing the session.`
    );
  }
}

function mcpUrlEnv(name: string): string {
  return `GUGU_SESSION_MCP_URL_${name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
}

function mcpAuthEnv(name: string): string {
  return `GUGU_SESSION_MCP_AUTH_${name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
}

function materializeMcpEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  for (const server of bundle.mcpServers) {
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, 'Claude');
      for (const ref of Object.values(server.env ?? {})) {
        env[ref] = bundle.env[ref] as string;
      }
      continue;
    }
    env[mcpUrlEnv(server.name)] = server.url;
    const auth = sessionMcpAuthorization(server, bundle.env, 'Claude');
    if (auth) env[mcpAuthEnv(server.name)] = auth;
  }
}

/**
 * 聊天面板腿的桥接(`@gugu-acp/claude-agent-acp`)把 Claude **确认过**的上下文窗口记在这个目录(#6552)。
 *
 * 在一轮的 `result` 报回真实窗口之前,桥接只能按模型名里有没有「1m」去猜 —— Opus 5.5 原生 1M、
 * 名字里却没有 1m,于是猜成 200k。桥接本来会记住确认过的窗口,但只记在进程内存里;咕咕一条会话
 * (一个 side chat)一个适配器进程 ⇒ 每条会话都从空的开始,首轮一律显示猜的数。给它一个跨进程的
 * 目录,确认过一次的窗口之后每条会话一开场就对。
 * 只有 1.1.x 读它(配对表仍把 CLI 2.1.267–2.1.285 配给 1.1.2);1.2.0 起桥接开场自己确认窗口,不再读这个目录。
 *
 * ❌ 不落在用户的 `~/.claude`(咕咕不改写用户的 claude 配置);落在咕咕自己的数据根下。
 * 调用方没给 `GUGU_HOME`(只有不经宿主的单测会这样)就不给这个变量 —— 桥接那一侧的语义是
 * 「不记跨进程」,与没有这个补丁时一样,不是换一个猜法。
 */
export const CLAUDE_ACP_BRIDGE_STATE_DIR_ENV = 'CLAUDE_AGENT_ACP_STATE_DIR';

function claudeAcpBridgeStateEnv(bundle: SessionCapabilityBundle): Record<string, string> {
  const guguHome = bundle.env.GUGU_HOME?.trim();
  if (!guguHome) return {};
  return { [CLAUDE_ACP_BRIDGE_STATE_DIR_ENV]: join(guguHome, 'acp-bridges', 'claude-agent-acp-state') };
}

function materializeModel(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  const model = bundle.model;
  if (!model) return;
  if (model.dialect !== 'provider-env') {
    throw new Error(`Claude session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const selected = model.model?.trim();
  if (!selected) return;
  const option = model.platformProvider ? claudePlatformModelOption(selected, model.contextWindow) : selected;
  env.ANTHROPIC_MODEL = option;
  if (!model.platformProvider) return;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = option;
  env.ANTHROPIC_SMALL_FAST_MODEL = option;
}

function report(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization['report'] {
  const loaded = () => ({ status: 'loaded' as const });
  const degradedAutonomy = claudeSessionBundleDescriptor.units.autonomy.degraded;
  return {
    adapterId: 'claude',
    surface: ctx.surface,
    units: {
      mcp: loaded(),
      env: loaded(),
      model: bundle.model
        ? loaded()
        : { status: 'degraded', reason: { code: 'unverified', reason: 'No model was declared.' } },
      autonomy: { status: 'degraded', reason: degradedAutonomy },
      promptBlocks: renderPromptBlocks(bundle.promptBlocks)
        ? loaded()
        : {
            status: 'degraded',
            reason: { code: 'unverified', reason: 'No prompt blocks were declared.' },
          },
      packages: capabilityPackage(bundle)
        ? loaded()
        : {
            status: 'degraded',
            reason: { code: 'unverified', reason: 'No capability package was declared.' },
          },
    },
    discoveredCommands: [],
  };
}

/** The one Claude adapter core used by both session-page surfaces. */
export function materializeClaudeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface === 'app-server') {
    throw new Error(`Claude session adapter does not support surface '${ctx.surface}'`);
  }

  const packageEntry = capabilityPackage(bundle);
  assertPackageDeclaresMcpServers(bundle);
  const plugin = packageEntry ? { entry: packageEntry, root: packageRoot(bundle) } : null;
  const library = libraryPlugin(bundle);
  const env: Record<string, string> = {};
  materializeMcpEnv(bundle, env);
  materializeModel(bundle, env);
  const promptValue = renderPromptBlocks(bundle.promptBlocks);
  const delivered = deliveredPromptBlocks(bundle.promptBlocks);
  const appendTuiPrompt = ctx.lifecycle !== 'resume' && promptValue.length > 0;
  const artifacts = plugin
    ? [
        ...plugin.entry.artifacts.map((artifact) => ({
          ...artifact,
          path: join(plugin.root, artifact.path),
        })),
        // 这一份是**按会话生成**的(见 pluginMcpConfigFor);静态包里没有它,所以在这里补。
        {
          path: join(plugin.root, '.mcp.json'),
          content: pluginMcpConfigContent(bundle),
          mode: 0o644 as const,
        },
        ...(library?.artifacts ?? []),
      ]
    : [];

  const common = {
    env,
    artifacts,
    tomlOverlays: [],
    symlinks: plugin ? extensionSkillLinks(bundle, plugin.root) : [],
    directorySymlinkOverlays: [],
    report: report(ctx, bundle),
  };

  if (ctx.surface === 'tui') {
    const promptFile = appendTuiPrompt ? tuiPromptFile(bundle, promptValue) : null;
    const allowed = plugin ? guguMcpAllowRules(bundle) : [];
    return {
      ...common,
      artifacts: [...artifacts, ...(promptFile ? [promptFile] : [])],
      argsAppend: [
        // `--allowedTools` takes every argument up to the next flag: `--plugin-dir` must follow it.
        ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : []),
        ...(plugin ? ['--plugin-dir', plugin.root] : []),
        ...(library ? ['--plugin-dir', library.root] : []),
        ...(promptFile ? ['--append-system-prompt-file', promptFile.path] : []),
      ],
      ...(appendTuiPrompt ? { prompt: { value: promptValue, delivered } } : {}),
      acp: undefined,
      configMerges: [],
    };
  }

  const options = {
    ...(plugin ? { plugins: [{ type: 'local', path: plugin.root }, ...(library ? [{ type: 'local', path: library.root }] : [])] } : {}),
    // #5117 咕咕在子智能体卡上有「停止」按钮(适配器 `_session/async_task/stop` → SDK `stop_task`)。
    // 向 SDK 声明这一点(0.3.257 起认):按「停止」中断这一轮时**放过**还在跑的后台子智能体,
    // 由用户一个个停;不声明的话 SDK 会在中断时把后台任务全杀掉(它的 fail-closed 默认)。
    perTaskStopAffordance: true,
  };
  if (ctx.surface === 'acp') {
    // spec `mcp-session-toggle`:用户在 `/mcp` 里关掉的那几台,交给 claude 自己的 `disallowedTools`
    // (`mcp__<server>` 摘掉那一台的全部工具)。claude 照常自己解析它的每一层配置 —— 用户级、本地级、
    // 项目级、插件 —— 只少被关的那几台。归属来自能力包里的 owner 标记，❌ 不比名字常量。
    const disabled = new Set(bundle.mcpDisabled ?? []);
    const toggleServers: McpToggleServer[] = [
      ...bundle.mcpServers.map((server) => ({
        name: server.name,
        enabled: !disabled.has(server.name),
        // Legacy callers predate the owner marker and only ever supplied Gugu's bridge.
        // New user-config entries are marked explicitly by the Electron conversion boundary.
        owner: server.owner ?? 'gugu',
      })),
      ...[...disabled]
        .filter((name) => !bundle.mcpServers.some((server) => server.name === name))
        .map((name) => ({ name, enabled: false, owner: 'user' as const })),
    ];
    const directive = mcpToggleDirective('disallowed-tools', toggleServers, {
      granularity: 'per-server',
    });
    // 用户自己的那几台在 claude 眼里叫 `mcp__<名>`;咕咕经插件投递的(集成)叫 `mcp__plugin_<包>_<名>` ——
    // 与下面 `allowedTools` 同一个前缀。用户自己装的插件带的 server,读侧按 claude 的列法叫
    // `plugin:<插件>:<名>`(mcp-scopes.ts),工具前缀同样是 `mcp__plugin_<插件>_<名>`。
    const pluginOf = new Map(bundle.mcpServers.filter((server) => server.owner !== 'user').map((server) => [server.name, pluginIdOf(server)]));
    const disallowed = directive.kind === 'disallowed-tools'
      ? directive.disabled.map((name) => {
          const pluginId = pluginOf.get(name);
          return pluginId ? `mcp__plugin_${pluginId}_${name}` : claudeUserServerToolPrefix(name);
        })
      : [];
    const allowed = guguMcpAllowRules(bundle);
    return {
      ...common,
      // 桥接自己的状态目录只进**适配器进程**的 env(物化结果的 env 叠在它的 spawn env 最上面);
      // 下面 `claudeCode.options.env` 那一份是给 claude 的,仍是原来的 `env`。
      env: { ...env, ...claudeAcpBridgeStateEnv(bundle) },
      argsAppend: [],
      acp: {
        mcpServers: [],
        meta: {
          claudeCode: {
            options: {
              ...options,
              ...(allowed.length > 0 ? { allowedTools: allowed } : {}),
              // 适配器把它与自己的那份合并(`[...userProvidedOptions.disallowedTools, ...自己的]`),❌ 不覆盖。
              ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
              env,
            },
          },
        },
      },
      ...(promptValue ? { prompt: { value: promptValue, delivered } } : {}),
      configMerges: [],
    };
  }

  return {
    ...common,
    argsAppend: [],
    acp: {
      mcpServers: [],
      meta: {
        claudeCode: { options },
        ...(bundle.promptBlocks.platform
          ? { systemPrompt: { append: bundle.promptBlocks.platform } }
          : {}),
      },
    },
    ...(bundle.promptBlocks.platform
      ? { prompt: { value: bundle.promptBlocks.platform, delivered: ['platform'] } }
      : {}),
    configMerges: [],
  };
}

/** 用户那一侧的一台 server 在 claude 工具名里的前缀:插件带的 `plugin:<插件>:<名>` → `mcp__plugin_<插件>_<名>`,其余 `mcp__<名>`。 */
export function claudeUserServerToolPrefix(name: string): string {
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name);
  return plugin ? `mcp__plugin_${plugin[1]}_${plugin[2]}` : `mcp__${name}`;
}
