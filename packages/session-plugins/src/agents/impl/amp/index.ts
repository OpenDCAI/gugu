import {
  PLATFORM_NOT_WIRED,
  definePlugin,
  registerPluginBehavior,
  TUI_INTERRUPT_PAUSE,
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
import { AMP_PLUGIN_CONTENT } from './plugin-file';

const AMP_PLUGIN_PATH = '.amp/plugins/gugu-hook.ts';
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  deep: 'ultra',
  rush: 'low',
  smart: 'high',
};

// Amp thread ids are prefixed with 'T-'; only accept those for resume.
const validateProviderSessionId = (id: string) => id.startsWith('T-');
import { icon } from './icon';
import { ampMcpAdapter } from './mcp';

const sessionBundle = {
  injectionMode: 'runtime' as const,
  platform: PLATFORM_NOT_WIRED,
  shellEnv: { passThrough: ['AMP_API_KEY', 'AMP_TOOLBOX'] },
  surfaces: ['tui'],
  sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'local-session' } },
  units: {
    mcp: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    env: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    model: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  /**
   * 中断键 —— **Esc 连按两次**。官方 manual 原文(https://ampcode.com/manual,取证 2026-08-24):
   * 「Press Esc Esc to forcibly stop the agent and send your message immediately, when you want to
   * interrupt its work.」界面上那行提示也逐字说了要按两下:
   * `{key:"Esc", title:"Stop Agent Turn", description:"again to confirm", variant:"double-confirm"}`
   * (官方分发的二进制 `@ampcode/cli-linux-x64@0.0.1787573048-g90061d` 内嵌串)。
   *
   * `intervalMs` 取 150:同一份二进制里 `onEscPressed` 的第一下只是**起一个计时器**
   * (`cancelHintTimer = new I4H(this, 1000)`),第二下要落在这 1000ms 窗口内才会真的调
   * `cancelAgentLoop()`。上界 1000、下界是终端把两个 ESC 字节并成 `alt+esc` 的转义超时(几十毫秒),
   * 150 两头都留了余量。⚠️ 这个数是写 pty 的节拍参数,**不是键位本身**,故没有独立出处;
   * 键位的出处在 `evidence` 里。
   *
   * ⚠️ ❌ 不许写成 Ctrl-C。amp 的 `amp config keymap` 里 `ctrl+c` 是**和弦前缀**:
   * `"amp.quit": "ctrl+c ctrl+c"` / `"thread.archiveAndQuit": "ctrl+c ctrl+e"` —— 连按两下 Ctrl-C
   * 直接退出。填错就是「点暂停 = 退出 amp」。TUI 里唯一调 `cancelAgentLoop()` 的地方就是
   * `onEscPressed`,Ctrl-C 那条路从来不取消当前轮。
   *
   * ⚠️ 已知不覆盖的几种情形:Esc 在 `onEscPressed` 里是**分优先级下落**的 —— 正在编辑消息时先取消
   * 编辑、有选区时先清选区、agent 空闲时直接 `"ignored"`。失败方向是「没暂停」不是「杀会话」。
   *
   * ⚠️ **还有一条,就写在下面那句证据里,别漏读**:官方原文是「Press Esc Esc to forcibly stop
   * the agent **and send your message immediately**」—— 这一维在 amp 上不只是「停」。
   * `ptyController.interrupt` 是**盲写**字节的,它不知道用户在 amp 自己的输入框里排了什么;
   * 于是输入框非空时,咕咕的「暂停」会停下这一轮并**立刻用那段文字开下一轮**。
   * ❌ 这不是填错键位(键位是对的,`cancelAgentLoop` 只挂在 Esc 上),是这一家的 Esc Esc
   * 本身就带一个发送语义。要消掉它得先能读到 amp 输入框的状态,而 pty 这一侧读不到。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    presses: 2,
    intervalMs: 150,
    evidence:
      'https://ampcode.com/manual(Queueing Messages 节)「Press Esc Esc to forcibly stop the agent'
      + ' and send your message immediately」;窗口 1000ms 见官方二进制'
      + ' @ampcode/cli-linux-x64@0.0.1787573048-g90061d 的 onEscPressed/cancelHintTimer;取证 2026-08-24',
  },
  coexistence: {
    // TUI 腿的暂停:宿主按上面的键位往 pty 写字节(`ptyController.interrupt` → `tuiInterruptWrites`)。
    // ❌ 别手写这个字面量,主干 `TUI_INTERRUPT_PAUSE` 是唯一出处。
    pause: TUI_INTERRUPT_PAUSE,
    // 记忆文件在下面 `capabilities.memory` 登记,宿主 `readMemoryFiles` 按声明读得到。
    // channel 只能是 `agents-md`:amp **没有**自己的专名记忆文件(没有 `AMP.md`),
    // 三条登记路径全是 AGENTS.md 系。
    memory: { kind: 'native', channel: 'agents-md' },
    /**
     * `ampMcpAdapter()`(下方 behavior 里注册)扫 `~/.config/amp/settings.json` 的
     * `amp.mcpServers`(外加只读的旧路径 `~/.amp/config.json`),`readServers` 把文件里
     * **每一条**都映射出来 —— 读回的是用户自己登记的服务器,不只是咕咕写进去的那份。
     * 出口:plugin-host `readMcpServers` → agent-config `listForAgent`/`readAll`。
     * 不用启引擎,故是 `config-scan`。
     */
    introspection: { kind: 'native', channel: 'config-scan' },
    /**
     * TUI 腿的回传通道(主干见 `session-core/.../capabilities/tui-coexistence.ts`):
     * `createFileDropPlugin` 把 `plugin-file.ts` 的 `AMP_PLUGIN_CONTENT` 落到工作区的
     * `.amp/plugins/gugu-hook.ts`(下方 behavior 里注册,由
     * `hook-config-service.ts:72 ensureHooksInstalled` 在每次 spawn 前写盘);该插件挂
     * `amp.on('agent.start'|'agent.end')`,POST 到 `GUGU_HOOK_PORT` 的 `/hook`,
     * 宿主 `agent-hooks/hook-server.ts` 收下 → `event-enricher.ts` 归一 →
     * `agent-hook-service.ts:317` 落成 `conversations.agentStatus`。
     * 引擎自己的事件系统推出来的,故是 `event-stream`。
     *
     * ⚠️ amp 是少数**原生报 start** 的家(`supportedEvents` 含 'start'),「本轮在飞」不靠宿主
     * 从「用户按了回车」推 —— 对照 `agent-hook-service.ts:80 providerSupportsNativeStartHook`。
     */
    observability: { kind: 'native', channel: 'event-stream' },
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'amp',
    name: 'Amp',
    description:
      'Amp Code CLI for agentic coding sessions against your repository from the terminal.',
    websiteUrl: 'https://ampcode.com/manual#install',
  },
  {
    sessionBundle,
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['start', 'stop', 'session'],
    },
    // 托管安装:`@ampcode/cli` 把真正的程序体作为平台包发(`@ampcode/cli-<platform>-<arch>`,
    // 归档里就是一个可执行文件 `amp`)。
    // ⚠️ 厂商**没发** `@ampcode/cli-win32-arm64`(核于 2026-09-21 的 latest),所以那一格不声明 ——
    //    Windows ARM 上这家只能「你自己装,咕咕认」。
    hostDependency: miseDependency({
      id: 'amp',
      package: '@ampcode/cli',
      executables: {
        'darwin-x64': 'amp', 'darwin-arm64': 'amp',
        'linux-x64': 'amp', 'linux-arm64': 'amp',
        'win32-x64': 'amp.exe',
      },
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    /**
     * agent memory —— amp 全走 `AGENTS.md` 系,**没有**自己的专名文件(没有 `AMP.md`)。
     * 官方 manual 原文(https://ampcode.com/manual,取证 2026-08-24):
     *  · global :「System-wide guidance files, as well as both `$HOME/.config/amp/AGENTS.md` and
     *    `$HOME/.config/AGENTS.md`, are always included if they exist.」—— 是**两条**,不是一条。
     *  · project:「`AGENTS.md` files in the current working directory (or editor workspace roots)
     *    _and_ parent directories (up to `$HOME`) are always included」。
     *
     * ⚠️ 三类刻意没登记,都不是漏:
     *  1. **同目录的回退名**。manual 原文「If no `AGENTS.md` exists in a directory, but a file named
     *     `AGENT.md` (without an `S`) or `CLAUDE.md` does exist, that file will be included」——
     *     那是**每个目录内先命中先停**的回退链(官方二进制里 `Dc()` 遍历
     *     `["AGENTS.md","Agents.md","agents.md","AGENT.md","Agent.md","agent.md","CLAUDE.md"]` 且
     *     `break`)。`AgentMemoryEntry` 是一条一条**并列**读的,把回退名也登记进来会在
     *     两份都存在时读回两份 —— 把「二选一」记成「都要」,比缺一条更错。
     *  2. **父目录链**。manual 说 cwd 到 `$HOME` 的每一级都算,但 project 作用域的 fs 锚在工作区根,
     *     `resolveSafe` 对越出 root 的路径直接抛异常 —— 表达不了「往上走到 home」。
     *  3. **系统级**(`/etc/ampcode/AGENTS.md` 等):不在 global/project 两个作用域里,
     *     且 `AgentMemoryEntry` 的路径必须相对作用域根,绝对路径会被静默 join 进 home 下。
     */
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.config/amp/AGENTS.md' },
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.config/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    models: {
      kind: 'selectable',
      modelOptions: {
        low: {
          name: 'Low',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
        medium: {
          name: 'Medium',
          modelFeatures: { intelligence: 3, speed: 4 },
        },
        high: {
          name: 'High',
          modelFeatures: { intelligence: 4, speed: 3 },
        },
        ultra: {
          name: 'Ultra',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
      },
    },
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'stdin-pipe',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      resumeNeedsProviderId: true,
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(
        { ...ctx, model: LEGACY_MODEL_ALIASES[ctx.model] ?? ctx.model },
        {
          autoApproveFlag: '--dangerously-allow-all',
          initialPromptViaStdinPipe: true,
          extraEnv: { PLUGINS: 'all' },
          resumeFlag: 'threads continue',
          cliSessionIdFlag: 'threads continue',
          cliSessionIdOnResumeOnly: true,
          modelFlag: '-m',
        }
      ),
  },
  mcp: ampMcpAdapter(),
  plugins: createFileDropPlugin({
    relativePath: AMP_PLUGIN_PATH,
    content: AMP_PLUGIN_CONTENT,
    legacyRelativePaths: ['.amp/plugins/emdash-hook.ts'],
  }),
  sessions: { validateProviderSessionId },
});
