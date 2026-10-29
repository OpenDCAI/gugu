import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
  BARE_VERSION_LINE,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { GEMINI_PERMISSION_MODES } from './permission-modes';
import { icon } from './icon';
import {
  geminiSessionBundleDescriptor,
  materializeGeminiSessionBundle,
} from './session-bundle';
import { geminiMcpAdapter } from './mcp';

/**
 * Gemini CLI 自己会去读的记忆文件。
 *
 * 出处:https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md ——
 * 官方页把 `GEMINI.md` 定为默认 context 文件名,分层加载的第一层是
 * 「`~/.gemini/GEMINI.md`(in your user home directory)」,第二层是工作区目录及其父目录里的
 * `GEMINI.md`。`/memory add <text>` 追加的也是这个 global 文件。
 *
 * ⚠️ 通道是 `vendor-file` 不是 `agents-md`:GEMINI.md 是 Google 的专名文件,不属于 agents.md
 * 那族跨厂商约定 —— 通道名写错,读侧就再也认不出这两类文件的来源差别。
 *
 * ⚠️ 文件名可被 `settings.json` 的 `context.fileName` 改掉(官方页同段)。这里登记的是**默认名**;
 * 用户改过名时咕咕读回空 —— 那是欠账,不是假账。要收敛得先能读用户的 settings.json,
 * 那是 introspection 的活,不是本维的。
 */
const geminiMemory = {
  kind: 'files',
  entries: [
    // 相对 home:~/.gemini/GEMINI.md
    { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.gemini/GEMINI.md' },
    // 相对工作区根
    { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'GEMINI.md' },
  ],
} satisfies AgentMemoryDescriptor;

const sessionBundle = geminiSessionBundleDescriptor satisfies SessionBundleDescriptor;
const geminiMcp = geminiMcpAdapter();

/**
 * 能力声明的读数底座：2026-09-01 对 `@google/gemini-cli@0.57.0` 真机全量（#4655，
 * 隔离 cwd + 本地假 Gemini 线端点，零真实推理；配方与读数见 PR 与 gemini-session-bundle spec）。
 * ❌ 不是照抄 qwen 的形状 —— 同一家 fork 谱系恰好长得像，但每一格都单独量过；
 *    量出来**不一样**的地方（`auto_edit` 下划线 vs qwen 的 `auto-edit` 连字符、
 *    没有 `--continue`、MCP 的信任门与 node-26 断连）都记在各自的格上。
 */
export const plugin = definePlugin(
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI exposed through its native ACP server.',
    websiteUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    sessionBundle,
    /**
     * 厂商账号不是硬门槛 —— **实测**（判据与陷阱见 `capabilities/vendor-account.ts` 抬头）：
     * 只给 `GEMINI_API_KEY`（假值）+ `GOOGLE_GEMINI_BASE_URL`（本地假端点），零 Google 账号，
     * ACP session/new 成功、session/prompt 的请求真的发出（`x-goog-api-key` 逐字等于给的假 key），
     * 换 key/换 model 读数跟着变（变异对照）。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 指向本地假端点、零 Google 账号,session/prompt 的请求送达假端点且换 key/换 model 读数跟着变(变异对照)',
    },
    /**
     * `gemini --acp`：官方旗标（0.57.0 --help 与随包 docs/cli/acp-mode.md；
     * `--experimental-acp` 已标 deprecated）。initialize→session/new→session/prompt 全往返实测。
     */
    acp: {
      kind: 'supported',
    },
    /**
     * 四档由 ACP `session/new` 自报（0.57.0 逐字：default/autoEdit/yolo/plan），
     * 行为对照三档互不相同 —— 出处与映射理由见 `./permission-modes.ts` 的
     * `GEMINI_PERMISSION_MODES` 抬头。运行期经 `session/set_mode` 下发（实测 set_mode 后
     * yolo 0 询直跑、plan 0 询被拦）。
     */
    autoApprove: {
      kind: 'supported',
      modes: GEMINI_PERMISSION_MODES,
    },
    // ── auth：❌ 这一家不声明（#6100）─────────────────────────────────────────
    // gemini 没有 `login` 子命令（0.57.0 --help 的命令表里没有；"Log in with Google" 是 TUI
    // 内的交互流程），所以它**在产品里没有任何登录动作**：`plugin-host.ts` 的
    // `buildLoginCommand` 只接 `cli-login`，而 `api-key` 那一格咕咕从来没有填 key 的界面 ——
    // 声明它换不来一个能点的东西。
    // ⚠️ 连带删掉的还有登录**态**判据（原 ./auth.ts 的 `geminiAuthStatus`）：
    //    `checkAuthStatusUncached` 的闸是 `provider.auth.kind === 'none' ⇒ unknown`，
    //    descriptor 一走那个行为就永远跑不到 —— 留着就是下一个「有行为没声明」。
    //    真要把 gemini 的登录态接回来，先决定它的登录动作长什么样，❌ 别先补一个读不到的判据。
    // 托管安装(npm backend):`@google/gemini-cli` 是纯 JS(bin `bundle/gemini.js`),
    // 依赖树由 mise 内置的 aube 装,机器上不需要有 node/npm;跑它的 node 由咕咕自己钉。
    hostDependency: { ...miseDependency({
      id: 'gemini',
      backend: 'npm',
      package: '@google/gemini-cli',
      node: MANAGED_NODE_VERSION,
    }), versionLine: BARE_VERSION_LINE },
    /**
     * 用户自己往这家装 MCP server 的通道：`~/.gemini/settings.json` 的 `mcpServers`
     * （适配器早已存在于 session-core helpers —— qwen 的适配器就是它的别名）。
     * stdio 走 `command`，http 走 `httpUrl`（写侧 `geminiMcpAdapter.toNative` 两支都产出）。
     * ⚠️ 连接侧有信任门与 node-26 断连两个前置，记在 session-bundle.ts 抬头 —— 它们影响
     *    「连不连得上」，不影响「写不写得进配置」这一格的真值。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    memory: geminiMemory,
    /**
     * 首句通道 —— argv（0.57.0 --help 逐字：`-i, --prompt-interactive  Execute the provided
     * prompt and continue in interactive mode`）。ACP 腿上首句走 `session/prompt`
     * （providerConsumesStartupPrompt 对 acp 恒真），聊天页新建在会话页 injector 边界
     * 裹成 `route=chat` 信封（#4612 通用链路）—— ❌ 没有任何 pty 打字/延时注入。
     */
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '-i',
    },
    /**
     * 可续（两条腿都有一手证据）：
     * · TUI：`--resume <uuid>` 官方在案（随包 docs/cli/session-management.md 示例逐字给了
     *   UUID 形参），另有 `--list-sessions` / `--session-id`。
     * · ACP：initialize 回包 `agentCapabilities.loadSession: true`（0.57.0 实测），
     *   `session/load` 在方法表里（随包 docs/cli/acp-mode.md）。
     */
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeGeminiSessionBundle, platformModel },
  /**
   * `--skip-trust` 是 MCP 投递的硬前置：未信任目录下 session/new 的 mcpServers 被**静默**
   * 忽略（实测 0.57.0：不带它 0 hit，带它同一探针 initialize→tools/list 全通）。
   * 语义是「Trust the current workspace for this session」（--help 逐字）——会话级、零落盘，
   * 作用域就是咕咕这次 spawn 的工作目录；❌ 不写用户的 ~/.gemini/trustedFolders.json
   * （那会替他往全局信任库里积累一次性工作区条目）。
   */
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp', '--skip-trust'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // ⚠️ gemini 的档名是 `auto_edit`（下划线），qwen fork 改成了 `auto-edit` —— 别互抄。
        autoApproveFlag: '--approval-mode=yolo',
        planFlag: '--approval-mode=plan',
        editFlag: '--approval-mode=auto_edit',
        initialPromptFlag: '-i',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
        // gemini 没有 `--continue`（0.57.0 --help 无此旗标）；官方文档「latest」是最近会话。
        resumeWithoutSessionFlag: '--resume latest',
        modelFlag: '-m',
      }),
  },
  mcp: geminiMcp,
});

export {
  geminiSessionBundleDescriptor,
  materializeGeminiSessionBundle,
} from './session-bundle';
