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
import {
  buildStandardCommand,
  createFileDropPlugin,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';
import { KILOCODE_PLUGIN_CONTENT } from './plugin-file';

const KILOCODE_PLUGIN_PATH = '.kilo/plugins/gugu-notifications.js';

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
   * TUI 腿的中断键 —— **Esc,单按**。
   *
   * 一手出处是上游源码的键位表,不是 #3889 的证据串(那一列是二手转述,已知会记反):
   * Kilo-Org/kilocode@88083fb5c51b0214a49081dacb7a02c78fe5c95a
   * `packages/tui/src/config/keybind.ts`
   *   :97 `session_interrupt: keybind("escape", "Interrupt current session")`
   *   :48 `app_exit:          keybind("ctrl+c,ctrl+d,<leader>q", "Exit the application")`
   *   :165 `input_clear:      keybind("ctrl+c", "Clear input field")`
   *
   * ⚠️ 所以 **❌ 绝对不能写 Ctrl-C**:在这一家它绑的是**退出整个 app**。填错的代价不是
   * 「点了没反应」,是把用户正在跑的会话杀掉而界面报「已暂停」。
   * 单按 Esc 的失败方向是安全的:没在跑时它至多关掉一个面板。
   *
   * ⚠️ 这里**不动** `coexistence.pause`:kilocode 是双腿的家(acp + tui),pause 记的是
   * ACP 腿更强的 `protocol-cancel`,中断键只由本字段记录(判据见 core 的
   * `tuiInterruptSurfaceRequirement`)。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'Kilo-Org/kilocode@88083fb5c51b0214a49081dacb7a02c78fe5c95a'
      + ' packages/tui/src/config/keybind.ts:97 session_interrupt=escape'
      + '(:48 app_exit=ctrl+c,ctrl+d —— Ctrl-C 是退出,不是中断);取证 2026-08-24',
  },
  coexistence: {
    // 这三条都由 ACP 腿(`surfaces` 含 'acp',provider.acp = createNativeAcpBehavior)提供,
    // 与厂商无关 —— 咕咕对任何走 ACP 的家都已接通(⚠️ plan/todo **不在此列**,见下方单独说明):
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    //  · observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState
    //    产出 isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    //  · askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options
    //    的待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //    resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕
    //    没通,❌ 不许声明。
    //    另有 event-stream 通道:plugin-file.ts:59,70 把 session.idle / session.error POST 到
    //    GUGU_HOOK_PORT(消费方 宿主 agent-hook-service 的 deriveAgentStatus);
    //    单维只能记一个通道,这里取信号更全的 acp-update —— 它报「本轮在飞」,
    //    hook 链主要报「转空闲」。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    // ⚠️ todo 单独排除:**咕咕经这条腿收不到结构化 plan**。依据 #3889 横向发现②
    //    ——「『原生能力』和『经 ACP 拿得到的能力』必须分两栏,且不能互推」:
    //    opencode / goose / letta 的 ACP 桥不发 plan,grok / mistral / hermes 发,3:3,
    //    是实现差异不是协议限制。kilocode 落在**不发**那一栏,答案键证据串写得很明:
    //    「todowrite结构化数组/ACP桥收不到」—— 厂商侧**是有** todowrite 的,断的是 ACP 这一段。
    //    所以整条移除、落回基类;❌ 不许读成「厂商没有 todo」,也不许改写成 none 去替厂商下结论。
    // memory:对应下面 `capabilities.memory` 登记的 `AGENTS.md` / `AGENT.md` —— 登记了文件,
    //    宿主 `AgentPluginHost.readMemoryFiles` 就真读得回来。
    memory: { kind: 'native', channel: 'agents-md' },
    // ⚠️ introspection 不算:kilocode 的 plugins 是 file-drop —— 咕咕**写**自己那个
    //    gugu-notifications.js 进去,并不读用户自己的 plugin / MCP 清单;也没有 mcp 行为可扫。
    //    其余四维(todo / introspection / history / cron)落回基类,
    //    历史读回只接了 claude-code 与 codex(transcriptInventory.ts)。
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'kilocode',
    name: 'Kilocode',
    description:
      'Kilo AI coding assistant with multiple modes, broad model support, and checkpoint-based workflows.',
    websiteUrl: 'https://kilo.ai/docs/cli',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session'],
    },
    // 托管安装:程序体在 `@kilocode/cli-<platform>-<arch>` 里(六格齐全,归档内 `bin/kilo`)。
    // `id` 写厂商真正的二进制名 `kilo` —— 它同时是启动器文件名与探测名,写成 `kilocode`
    // 就再也认不出用户自己装的那一份。
    hostDependency: miseDependency({
      id: 'kilo',
      package: '@kilocode/cli',
      platformPackages: {
        'darwin-x64': '@kilocode/cli-darwin-x64', 'darwin-arm64': '@kilocode/cli-darwin-arm64',
        'linux-x64': '@kilocode/cli-linux-x64', 'linux-arm64': '@kilocode/cli-linux-arm64',
        'win32-x64': '@kilocode/cli-windows-x64', 'win32-arm64': '@kilocode/cli-windows-arm64',
      },
      executables: {
        'darwin-x64': 'bin/kilo', 'darwin-arm64': 'bin/kilo',
        'linux-x64': 'bin/kilo', 'linux-arm64': 'bin/kilo',
        'win32-x64': 'bin/kilo.exe', 'win32-arm64': 'bin/kilo.exe',
      },
    }),
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    // agent memory —— kilocode 读 AGENTS.md 系。
    // 出处:https://kilo.ai/docs/customize/agents-md(取证 2026-08-24)——「Place your AGENTS.md
    // file at the root of your project」,文件名按 `AGENTS.md`(推荐)→ `AGENT.md`(回退)取,
    // 且原文强调必须大写。同页另说 CLI 兼容 `.claude/` 与 `.agents/` 目录。
    // ⚠️ 两处**故意没登记**,是取证不足不是漏做:
    //  · 子目录里的 AGENTS.md(官方说「in subdirectories to provide context-specific
    //    instructions」)—— `AgentMemoryEntry` 表达不了「整棵树递归找」,硬写一层是猜。
    //  · `.claude/` / `.agents/` 兼容目录 —— 官方没写具体文件名,登记错就会读回不是记忆的东西。
    //  · global 作用域官方一条都没写(只提到 global `kilo.jsonc` 放 instructions,那是配置不是
    //    记忆文件)→ ❌ 不许照别家的 `~/.<vendor>/` 惯例外推。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle(zod 4 的 ZodType Input 是 unknown)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENT.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      // `kilo <positional>` is interpreted as the project directory and gets
      // realpath()'d, which throws ENAMETOOLONG on large prompts (ENG-1546).
      // The interactive TUI accepts the initial prompt via `--prompt` instead.
      flag: '--prompt',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  acp: createNativeAcpBehavior(() => ({
    args: ['acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--auto',
        initialPromptFlag: '--prompt',
        resumeFlag: '--continue',
      }),
  },
  plugins: createFileDropPlugin({
    relativePath: KILOCODE_PLUGIN_PATH,
    content: KILOCODE_PLUGIN_CONTENT,
    legacyRelativePaths: ['.kilo/plugins/emdash-notifications.js'],
  }),
});
