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
  passthroughMcpAdapter,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import {
  CODEBUDDY_ACP_CHINA,
  CODEBUDDY_ACP_INTERNATIONAL,
  CODEBUDDY_CHINA_LOGIN_METHOD_ID,
  CODEBUDDY_INTERNATIONAL_LOGIN_METHOD_ID,
  codebuddyAuthStatus,
} from './auth';
import { buildCodebuddyHookConfig } from './hooks';
import { icon } from './icon';
import { CODEBUDDY_PERMISSION_MODES } from './permission-modes';
import {
  codebuddySessionBundleDescriptor,
  materializeCodebuddySessionBundle,
} from './session-bundle';

const sessionBundle = codebuddySessionBundleDescriptor satisfies SessionBundleDescriptor;

/**
 * CodeBuddy Code —— 腾讯的终端 agent。命令行、hooks、settings、stream-json 的形状几乎就是 Claude Code,
 * 实现是它自己的(原生 ACP、自己的转录格式)。调研与实测在 2026-10-19。
 */
export const plugin = definePlugin(
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    description:
      "Tencent's terminal coding agent: understands the codebase, edits files, runs commands, and handles whole workflows.",
    websiteUrl: 'https://www.codebuddy.ai/docs/cli/overview',
  },
  {
    sessionBundle,
    /**
     * 厂商账号不是硬门槛 —— **实测**:只给 `CODEBUDDY_BASE_URL` + `CODEBUDDY_API_KEY` 时
     * `session/new` 照常开、请求打到给定的网关(实测 B);两者都不给才回 `Authentication required`(实测 A)。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '2.169.0 隔离 HOME:无凭据 → session/new -32000 Authentication required;CODEBUDDY_BASE_URL + CODEBUDDY_API_KEY → '
        + 'session/new 成功、POST {base}/chat/completions 落在给定网关(实测 A/B,2026-10-19)',
    },
    // `--effort <level>` —— `codebuddy --help` 原文「Reasoning effort level (minimal, low, medium, high, xhigh, max)」;
    // ACP 腿另有 configOptions `thought_level`(实测 B)。
    effort: {
      kind: 'selectable',
      effortOptions: {
        minimal: { name: '最低', description: '几乎不做额外推理' },
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
      },
    },
    acp: {
      kind: 'supported',
      /**
       * 2026-10-19 mac1 实测(2.169.0,裸 ACP + 本地假网关):`session/new` 报 configOptions `mode` / `model` /
       * `thought_level`;`session/set_config_option` 设 `mode=bypassPermissions` / `mode=default` /
       * `thought_level=high` 都在应答里读回设进去的值 ⇒ 权限与推理强度走 `acp-config-option`、`ack-read-back`。
       *
       * 模型 ❌ 走热切:`model=<任意 id>` 它也收、下一轮主请求就换了,但 `CODEBUDDY_SMALL_FAST_MODEL` 那些后台槽位
       * 留在旧模型上,而平台令牌在网关上只白名单一个 ⇒ 按新模型重新物化 `--settings` 文档(所有槽位一起)再
       * `session/load`:实测换进程后 `session/load` 跟随新的 `CODEBUDDY_MODEL`(读回 model-b、下一轮请求也是 model-b)。
       *
       * 忙时一律 `reject`:运行中改配置这一层没量过,❌ 先声明更松的。
       */
      liveSettings: {
        model: { channel: 'reload-session', ack: 'none', busy: 'reject', reloadRequired: true, recovery: 'runtime-restart' },
        permission: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none', allowStartupDowngrade: true },
        effort: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
      },
    },
    /**
     * 怎么登 —— 协议登录(出处见 ./auth.ts):国际版与中国版两个入口,登录由用户自己在浏览器里完成。
     */
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'acp-authenticate',
          id: CODEBUDDY_INTERNATIONAL_LOGIN_METHOD_ID,
          name: 'CodeBuddy 国际版（Google / GitHub）',
          methodId: CODEBUDDY_ACP_INTERNATIONAL,
          description: 'Opens CodeBuddy sign-in (www.codebuddy.ai) in your browser; CodeBuddy runs the sign-in itself.',
        },
        {
          kind: 'acp-authenticate',
          id: CODEBUDDY_CHINA_LOGIN_METHOD_ID,
          name: 'CodeBuddy 中国版（微信）',
          methodId: CODEBUDDY_ACP_CHINA,
          description: 'Opens CodeBuddy sign-in (copilot.tencent.com) in your browser; CodeBuddy runs the sign-in itself.',
        },
      ],
    },
    autoApprove: {
      kind: 'supported',
      modes: CODEBUDDY_PERMISSION_MODES,
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session', 'start', 'tool-use', 'tool-use-failure'],
    },
    /**
     * MCP —— 用户级配置按它自己的读取顺序:`~/.codebuddy/.mcp.json` → `~/.codebuddy/mcp.json`(已弃用)
     * → `~/.codebuddy.json`(旧),读第一份存在的(官方 https://www.codebuddy.ai/docs/cli/mcp「USER Scope」)。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'mcp__gugu__', evidence: 'macOS 实测 F(2026-10-19):session/new 注入的 echo server 带 `_meta.defer_loading:false` 后直接上工具表,名字是 mcp__echo__echo' },
    },
    // 托管安装(npm backend):本体是 JS(`bin/codebuddy` → `dist/codebuddy.js`),node-pty 等原生件是
    // optionalDependencies,按本机平台挑。npm `bin` 同时发 `codebuddy` / `cbc` / `codebuddy-code`。
    hostDependency: miseDependency({
      id: 'codebuddy',
      aliases: ['cbc', 'codebuddy-code'],
      backend: 'npm',
      package: '@tencent-ai/codebuddy-code',
      node: MANAGED_NODE_VERSION,
      installDocs: 'https://www.codebuddy.ai/docs/cli/quickstart',
    }),
    // 记忆文件 —— `CODEBUDDY.md`(发行包里 19 处,与 Claude 的 CLAUDE.md 同一个位置)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.codebuddy/CODEBUDDY.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'CODEBUDDY.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      // `--session-id <uuid>` 起、`--resume <id>` 续(`codebuddy --help` 原文),与 Claude 同形。
      tuiResume: 'caller-id',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  auth: { checkStatus: codebuddyAuthStatus },
  sessionBundle: { materialize: materializeCodebuddySessionBundle, platformModel },
  // 会话级 argv(`--settings <文档>`)由物化器产出,经 `capabilityArgs` 挂在 `codebuddy --acp` 上。
  acp: createNativeAcpBehavior((ctx) => ({
    args: ['--acp', ...(ctx.capabilityArgs ?? [])],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // 每一档都显式给(理由同 Claude:不加 flag 时它自己挑启动档,可能比用户所选更松)。
        autoApproveFlag: '--permission-mode bypassPermissions',
        readOnlyFlag: '--permission-mode default',
        editFlag: '--permission-mode acceptEdits',
        planFlag: '--permission-mode plan',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--session-id',
        modelFlag: '--model',
        effortFlag: '--effort',
      }),
  },
  hooks: buildCodebuddyHookConfig(),
  mcp: passthroughMcpAdapter('.codebuddy/.mcp.json', ['.codebuddy/mcp.json', '.codebuddy.json']),
});
