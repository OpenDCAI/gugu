import {
  PLATFORM_NOT_WIRED,
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  createUnverifiedSessionBundleBehavior,
  UNVERIFIED_SESSION_BUNDLE_DELIVERY,
} from '../../helpers/session-bundle';
import { buildStandardCommand, miseDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';

const sessionBundle = {
  injectionMode: 'runtime' as const,
  platform: PLATFORM_NOT_WIRED,
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': { identity: 'none', messageTransport: 'none' },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
  },
  units: {
    mcp: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    env: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    model: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  /**
   * session-TUI 腿的中断键 —— **单按 Esc**。出处
   * `cline/cline@09ee9026393e681a4834d8acbf4d9d5fdfa8664a`
   * `apps/cli/src/tui/hooks/use-root-keyboard.ts`(取证 2026-08-24),原文:
   * `if (key.name === "escape") { … } else if (session.isRunning) { const abortStarted =
   * input.onAbort(); if (abortStarted) { session.setAbortRequested(true); … } }`
   * —— agent 在跑时单按 Esc 走 abort 当前轮,**进程不退、历史不丢**。
   * 界面提示同版本印证:`apps/cli/src/tui/components/chat-message-list.tsx`
   * 的 `Thinking... (esc to cancel)`;`/help` 对话框
   * (`components/dialogs/help-dialog.tsx`)那一行是 `key: "Escape", desc: "Close menu / Abort
   * running agent"`。
   *
   * ⚠️ ❌ 千万别改成 Ctrl-C。同一文件的 Ctrl-C 分支是
   * `if (key.ctrl && key.name === "c") { if (!input.isDialogOpen && hasInputText) { …
   * setInputValue("") } else { input.onExit(); } }` —— 输入框空的时候它**直接退出**。
   * 而 agent 在跑时输入框通常正是空的,填错就是「点暂停 = 杀会话」。
   *
   * ⚠️ ❌ 也别写 presses: 2。同文件 idle 分支里 300ms 内的双按是**回滚到 checkpoint**
   * (`input.onRestoreCheckpoint()`),那是改用户工作区的动作,不是暂停。
   * 好在这条分支的前提是 `!session.isRunning`,所以单按在跑与不跑两种状态下都不会误伤。
   *
   * ⚠️ 这条**不改** `coexistence.pause`:cline 是双腿家,pause 记的是 ACP 腿的
   * `protocol-cancel`;中断键只由本字段记录,供 `ptyController.interrupt` 在 TUI 会话上使用。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'cline/cline@09ee9026393e681a4834d8acbf4d9d5fdfa8664a'
      + ' apps/cli/src/tui/hooks/use-root-keyboard.ts(escape 分支 → session.isRunning →'
      + ' input.onAbort();同文件 ctrl+c 分支 → input.onExit());取证 2026-08-24',
  },
  coexistence: {
    // 这四条都由 ACP 腿(`surfaces` 含 'acp',provider.acp = createNativeAcpBehavior)提供,
    // 与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    //  · plan:decode 出 { kind:'plan', entries } 后由 reducer/item-fold 折进 transcript。
    //  · observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState
    //    产出 isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    //  · askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options
    //    的待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //    resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕
    //    没通,❌ 不许声明。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    // ⚠️ `todo` 曾按「surfaces 含 acp ⇒ 收得到结构化 plan」声明过,已撤 —— 那是横切外推,
    // 被考卷当场判为「声明了做不到」:#3889 的官方证据里 cline 的 todo 状态是 **none**(无出处(❌ 该维在 #3889 表里就是空)),
    // 即厂商这一端根本不产出结构化 plan 事件,咕咕的 decode 再全也无从收起。
    // ❌ 措辞注意:整条落回基类 = 咕咕没接通;不许改写成 `none + unsupported-channel` 替厂商下结论。
    // ⚠️ 补一条一手佐证(2026-08-24):cline 的 ACP server 源码
    // `cline/cline@09ee9026393e681a4834d8acbf4d9d5fdfa8664a` `apps/cli/src/acp/session-updates.ts`
    // 只 emit 8 种 sessionUpdate(agent_message_chunk / agent_thought_chunk / config_option_update /
    // current_mode_update / session_info_update / tool_call / tool_call_update / user_message_chunk),
    // **没有 `plan`**。⚠️ 别被 `acpAgent.ts` 里那个 `id: "plan"` 误导 —— 那是 ACP 的会话**模式**
    // (经 `current_mode_update` 报出),不是 plan 这条 update。
    // 记忆文件在下面 `capabilities.memory` 登记,宿主 `readMemoryFiles` 按声明读得到。
    // channel 取 `vendor-file`:两个作用域里都有 cline 自己的 `rules` 目录,覆盖面比 AGENTS.md 全。
    memory: { kind: 'native', channel: 'vendor-file' },
    // 其余三维落回基类:
    //  · introspection:cline 有 `cline config mcp --json`,但那是另起一个进程;咕咕既没有 mcp
    //    adapter(无处 config-scan),它的 ACP 腿也**不发** `available_commands_update` ——
    //    同一份源码里全仓 grep `available_commands` 零命中(阳性对照:`session_info_update`
    //    命中 2 处)。所以 running-engine 这条也不成立。对照 auggie:那家发,故那家声明了。
    //  · history:会话落在 `~/.cline/data/sessions/<id>/<id>.messages.json`,是**整份 JSON**
    //    不是 jsonl(索引另在 `~/.cline/data/db/sessions.db` 的 SQLite),而 core 的
    //    `TranscriptStorageChannel` 今天只有 `'jsonl'` 一种。
    //    ⚠️ 官方文档这一处是错的(`docs/cli/cli-reference` 把 `sessions/` 写成 SQLite),以源码为准。
    //  · cron:整列缺主干。
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'cline',
    name: 'Cline',
    description:
      'Cline CLI runs coding agents directly in your terminal with multi-provider model support.',
    websiteUrl: 'https://docs.cline.bot/cline-cli/overview',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    // 托管安装:`cline` 这个包只是个启动器,程序体在 `@cline/cli-<platform>-<arch>` 里
    // (六格齐全;bun 编的那一族把 `win32` 叫 `windows`,所以平台包名要写明)。
    hostDependency: miseDependency({
      id: 'cline',
      package: 'cline',
      platformPackages: {
        'darwin-x64': '@cline/cli-darwin-x64', 'darwin-arm64': '@cline/cli-darwin-arm64',
        'linux-x64': '@cline/cli-linux-x64', 'linux-arm64': '@cline/cli-linux-arm64',
        'win32-x64': '@cline/cli-windows-x64', 'win32-arm64': '@cline/cli-windows-arm64',
      },
      executables: {
        'darwin-x64': 'bin/cline', 'darwin-arm64': 'bin/cline',
        'linux-x64': 'bin/cline', 'linux-arm64': 'bin/cline',
        'win32-x64': 'bin/cline.exe', 'win32-arm64': 'bin/cline.exe',
      },
    }),
    /**
     * agent memory —— cline **CLI** 自己会去读的规则文件。
     *
     * ⚠️ 判据只取 CLI 那一支,❌ 不取 VS Code 扩展:两者是**两套独立实现、两套常量**
     * (CLI 在 `apps/cli/` + `sdk/packages/`,扩展在 `apps/vscode/`)。扩展读
     * `.cursorrules` / `.windsurfrules`、全局规则在 `~/Documents/Cline/Rules`;CLI 全不是这样。
     * 照「cline 支持四种规则格式」那类跨形态说法抄,会给 CLI 登记一堆它根本不读的路径。
     *
     * 出处 `cline/cline@09ee9026393e681a4834d8acbf4d9d5fdfa8664a`(取证 2026-08-24)
     * `sdk/packages/shared/src/storage/paths.ts:490-509` 的 `resolveRulesConfigSearchPaths()`,
     * 配合同文件的常量(`:34 DEPRECATED_CONFIG_DIR=".clinerules"`、`:35 CLINE_CONFIG_DIR=".cline"`、
     * `:41 RULES_CONFIG_DIRECTORY_NAME="rules"`、`:44 AGENTS_RULES_FILE_NAME="AGENTS.md"`、
     * `:36 LEGACY_AGENT_SKILLS_CONFIG_DIR=".agents"`、`:130 resolveClineDir()` → `~/.cline`)。
     * 目录内收哪些后缀见 `sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts:27`
     * 的 `MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".txt"])`。
     *
     * ⚠️ 两条搜索路径**刻意没登记**:
     *  · `<workspace>/.clinerules` —— 它可以是文件**也可以**是目录(同一份源码里先 `stat` 再分流),
     *    而 `AgentMemoryEntry` 必须二选一。登记成 file 而用户放了目录时,`PluginFs.read` 会
     *    抛 EISDIR(不是 ENOENT,吞不掉);登记成 directory 而用户放了文件则静默读空。
     *    这是模型缺一种「file-or-directory」形态,不是这份声明偷懒。
     *  · `~/Documents/Cline/Rules` —— `resolveDocumentsExtensionPath` 在各平台解析不同
     *    (Windows 的 Documents 还可能被 OneDrive 重定向),写死 `Documents/...` 只在部分机器上对。
     *
     * ⚠️ 官方文档在全局规则目录这一处是**错的**:`docs/cli/cli-reference` 写
     * `~/.cline/data/settings/rules/`,而源码的用例
     * (`sdk/packages/shared/src/storage/paths.test.ts`)明确断言**不是**那个路径。以源码为准。
     */
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.agents/AGENTS.md' },
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.cline/rules',
          suffixes: ['.md', '.markdown', '.txt'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.cline/rules',
          suffixes: ['.md', '.markdown', '.txt'],
        },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'stateless',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--yolo',
        initialPromptFlag: '',
      }),
  },
});
