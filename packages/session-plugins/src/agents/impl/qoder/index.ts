import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  materializeQoderSessionBundle,
  qoderSessionBundleDescriptor,
} from './session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
  passthroughMcpAdapter,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { QODER_LOGIN_METHOD_ID, qoderAuthStatus } from './auth';
import { buildQoderHookConfig } from './hooks';
import { icon } from './icon';

const sessionBundle = qoderSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'qoder',
    name: 'Qoder CLI',
    description:
      'Qoder terminal agent for code review, implementation, debugging, and repository-aware automation.',
    websiteUrl: 'https://qoder.com/en/cli',
  },
  {
    sessionBundle,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    vendorAccount: {
      kind: 'required',
      evidence:
        '两条 BYOK 路都撞墙：modelConfigs.customModels + `-m` → `Not logged in · Please run /login`；切到 security.auth.useExternal + providers.<id> 后**跳过**该闸（判据函数即 isQoderProvider），改卡在 WASM `QoderContext not created. Call createContext() after login.`（由登录后的 userInfoJson 构造）',
    },
    /**
     * 推理强度 —— 逐条说清楚哪些是量到的、哪些不是。
     *
     * **量到的**(2026-08-26,隔离 HOME,零推理请求):
     *  · `qoder --help` 原文有 `--reasoning-effort <level>  Set reasoning effort level`
     *    ⇒ 这条轴**确实存在**;
     *  · 但那一行**没有列 choices**(对照:同次量的 copilot 就把七档写在 help 里)。
     *
     * **从它自己的产物里读到的**:qodercli 的 bundle 有一张 key 名单
     *   `["efforts","reasoning_efforts","reasoningEfforts","reasoning_effort_levels",
     *     "reasoningEffortLevels","effort_level",…,"levels"]`,
     * 校验函数是 `(A,e) => !A || nx(A).includes(e)` ——
     * 也就是**档位来自模型元数据**,模型没声明清单时**任何取值都接受**。
     * 同一份产物里出现的最长那条阶梯是 `"none","low","medium","high","xhigh","max"`。
     *
     * ⇒ 这张表按那条最长阶梯写。它成立的依据是「模型没声明清单就全接受」这条分支,
     *   而咕咕平台会话的模型文档正是**咕咕自己写的**(见 session-bundle 的 `--settings` 文档),
     *   里面不写 effort 清单 ⇒ 落在 `!A` 那一支。
     *
     * ⚠️ **没有**验过的:用户自己 BYOK 配了一个**自带** effort 清单的模型时,清单更窄。
     *    那种情况下这张表会列出该模型不接受的档位。补救不靠这张表,靠活会话 ——
     *    ACP 起来后 `thought_level` 会 re-advertise 真实档位,composer 切到那份(见
     *    harness-model-field 的 harnessCatalogToEfforts)。这张表只是读不到活目录时的来源。
     */
    effort: {
      kind: 'selectable',
      effortOptions: {
        none: { name: '关闭', description: '这一轮不做额外推理' },
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
      },
    },
    acp: {
      kind: 'supported',
    },
    /**
     * 怎么登 —— 出处与两个分支的理由见 `./auth.ts`。
     *
     * ⚠️ 这一格对 qoder 不是可选项:它是 P0 里唯一一家 `vendorAccount: 'required'`,
     *    上面那条实测依据里的 `Not logged in · Please run /login` 就是它的闸。
     *    不声明就是**真的没有登录入口**(spec: harness-auth-surface,payload 只直通声明,
     *    ❌ 不兜通用方法)—— owner 2026-08-26 实测「提示需要登录」却无处可去,就是这个缺口。
     *
     * ❌ 不声明 `api-key` 方法承载 `QODER_PERSONAL_ACCESS_TOKEN`:那一支现在没有任何界面消费,
     *    摆出来等于摆一个填了不知道去哪的表单。它只作为**判据**用在 ./auth.ts 里。
     */
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: QODER_LOGIN_METHOD_ID,
          name: 'Sign in to Qoder',
          args: ['login'],
          description:
            'Runs `qodercli login`: opens your browser to authorize your Qoder account, and prints the sign-in URL instead when there is no display.',
        },
      ],
    },
    autoApprove: {
      kind: 'supported',
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session', 'start', 'tool-use', 'tool-use-failure'],
    },
    /**
     * MCP —— 用户级 `~/.qoder/settings.json` 的 `mcpServers` 键,canonical JSON 形状。
     *
     * 键名与逐服务器形状的出处见 `session-bundle.ts` 的 `introspection` 那段(两处官方文档
     * 表格 + 一次 `qodercli mcp add` 实测)。`passthroughMcpAdapter` 的 `toNative` 是「去掉
     * name、其余原样」,与实测写出来的 `{ "command": "echo", "args": ["hi"] }` 对得上。
     *
     * ⚠️ transports 只报 stdio / http:`McpTransport` 这个类型就只有这两个值。qoder 自己的
     * `mcp add -t` 还认 `sse` / `ws`,读回来时它们会原样留在条目里(passthrough 不裁字段),
     * 只是咕咕这一侧没有对应的枚举去描述它们。
     *
     * ⚠️ `writeServers` 是**读-改-写整份 settings.json**(`createMcpAdapter`:先 parse 现有
     * 文件、只替换 `mcpServers`、再整份写回),所以用户在同一份文件里的 hooks/permissions
     * 等键不会被抹掉。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    // 托管安装(npm backend):本体是 JS(bin `bundle/qodercli.js`),ripgrep 与 sharp 这些
    // 原生件作为 optionalDependencies 由 aube 按本机挑。
    // ❌ 厂商的 curl / powershell 脚本不再作为产品内装法(#6098)。
    //
    // ⚠️ `id` 取 `qodercli`:`@qoder-ai/qodercli` 的 npm `bin` **同时**发 `qodercli` 与 `qoder`
    //    (实测 `npm view @qoder-ai/qodercli bin`),而咕咕发布的启动器只叫一个名字 ——
    //    取官方文档的 CLI 名 `qodercli` 那一个,用户自己用脚本装的 `qoder` 仍由自动探测认出来。
    hostDependency: miseDependency({
      id: 'qodercli',
      // `qoder` 是同一个包的另一个 bin 名,官方文档一律用它 —— 用户用官方脚本装的那一份
      // 就叫这个。只探 `qodercli` 会把他判成「没装」(这条曾经真的发生过)。
      aliases: ['qoder'],
      backend: 'npm',
      package: '@qoder-ai/qodercli',
      node: MANAGED_NODE_VERSION,
      installDocs: 'https://qoder.com/en/cli',
    }),
    // agent memory —— qoder 走 AGENTS.md 系(跨厂商约定),不是自己的专名文件。
    // 出处:官方文档 https://docs.qoder.com/en/cli/memory ——「Within a Trusted Workspace,
    // searches upwards from the current Workspace directory for `AGENTS.md`, `AGENTS.local.md`,
    // and `.qoder/rules/**/*.md`」,用户级另有 `~/.qoder/AGENTS.md`(配置根 `~/.qoder`,
    // 可由 QODER_CONFIG_DIR 覆盖 —— 覆盖后这条 global 入口读到空,那是**声明了但磁盘上没有**,
    // 与「用户没写过」表现一致,不会误读别人的文件)。
    // ❌ 不登记 `.qoder/rules/**/*.md`:`AgentMemoryEntry` 的 directory 形态**只收顶层**
    //    (memory.ts 那段注释写死了),而 qoder 这条是递归 glob —— 登记它等于承诺读全、实际
    //    只读一层,是静默截断。要接需要先给 core 的 capability 加一个递归 kind(在禁改区),
    //    见本次报告。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.qoder/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.local.md' },
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
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  // 声明了 `auth` 就**必须**配 `behavior.auth`(framework 直接抛,不是软性约定)。见 ./auth.ts。
  auth: { checkStatus: qoderAuthStatus },
  sessionBundle: { materialize: materializeQoderSessionBundle, platformModel },
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--yolo',
        // `--reasoning-effort <level>` —— `qoder --help` 原文(2026-08-26 实测)。
        // 与 copilot 同理:不接这一格,档位就只是个装饰。
        effortFlag: '--reasoning-effort',
        initialPromptFlag: '',
        resumeFlag: '-r',
        cliSessionIdFlag: '-r',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '-c',
      }),
  },
  hooks: buildQoderHookConfig(),
  // 用户级那一份;❌ 不加 `${project}/.mcp.json` 之类的工作区路径 —— 这条路的 PluginFs 根是
  // `os.homedir()`,工作区相对路径会去家目录下找一个永远不存在的文件(静默读空)。
  mcp: passthroughMcpAdapter('.qoder/settings.json'),
});

// 平台模型在 qoder 模型目录里的 key —— 咕咕两条注入路径（插件物化器与桌面端
// `capability-bundle`）必须用**同一个字符串**：一边写进 `modelConfigs.customModels[].key`，
// 另一边填进 `QODER_MODEL`，分叉了就是「定义了一个模型、又去选另一个」。
