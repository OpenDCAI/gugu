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
import { buildStandardCommand, recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { buildDroidHookConfig } from './hooks';
import { icon } from './icon';
import { droidMcpAdapter } from './mcp';

// Droid reports its own UUID-based session ids; only accept well-formed UUIDs for resume.
const DROID_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validateProviderSessionId = (id: string) => DROID_SESSION_ID_PATTERN.test(id);

const sessionBundle = {
  injectionMode: 'runtime' as const,
  platform: PLATFORM_NOT_WIRED,
  shellEnv: { passThrough: ['FACTORY_API_KEY'] },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    // 加一家 = 本声明行(spec session-injection 加家判据;A/B 见该节点 droid-task-acp-onboarding
    // eval)。ACP 腿走宿主共用的会话页管子;时机档 next-tool-call 有专项读数 —— 忙时第二条
    // **标准** session/prompt 立即触发带新消息的模型调用,turn-1 自己的下一个工具边界请求也带上
    // 了新消息(3/3,idle 阳控通过;droid ACP,FACTORY_API_KEY 本地闸 + set_model 供能)。
    // 声明一落,内核 steer 下水道即在忙时直发同一条标准 session/prompt,零内核 diff。
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'next-tool-call',
        evidence: 'shuxueshuxue/gugu-base@39b451b5aad52ca8e7ca159996d718cae93316f8 evidence/2026-08-30-cursor-droid-grok-injection(droid ACP busy 3/3 next-tool-call;另见 #4490 eval)',
      },
    },
    'tui': {
      identity: 'addressable',
      messageTransport: 'local-session',
      hostAdapter: 'droid-daemon-v1',
    },
  },
  units: {
    mcp: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    env: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    model: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  coexistence: {
    // acp leg: the protocol cancel settles the turn as its own `cancelled` outcome —
    // the process stays up and the session keeps talking (acp/models/turns/turn.ts:22,45).
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // acp leg: `projectSessionState` reports the live turn — `isGenerating` / `canCancel` /
    // `lifecycle` (session-runtime/src/acp-agents/machine/machine.ts:410,413).
    observability: { kind: 'native', channel: 'acp-update' },
    // acp leg: authorization-type asks round-trip to the human — the agent's
    // `session/request_permission` becomes a pending request with options
    // (session-runtime/src/acp-agents/session/cell.ts:318), surfaces in the UI
    // (session-chat-ui/src/state/chat-state.ts:364), and the user's pick settles it (cell.ts:299).
    // ❌ Not the clarification-type ask (`mcp-elicitation` / `native-tool`): Gugu has no such route.
    askUser: { kind: 'native', channel: 'permission-ask' },
    // `droidMcpAdapter()` scans the user's own ~/.factory/mcp.json (plus the legacy
    // .droid/settings.json and .factory/config.json) and enumerates every entry it finds, not just
    // Gugu-authored ones (agents/plugins/helpers/mcp.ts:145,464 via plugin-host.ts:231).
    // ⚠️ Droid's hooks are deliberately *not* counted here: `readHooks` only answers whether
    // Gugu's own managed entries are installed (impl/droid/hooks.ts:72-77) — user hooks are
    // preserved on write but never enumerated.
    introspection: { kind: 'native', channel: 'config-scan' },
    // acp leg: `plan` session updates are normalized into structured entries, not prose
    // (acp/reducer/normalized-event.ts:155).
    // ⚠️ `todo` 曾按「surfaces 含 acp ⇒ 收得到结构化 plan」声明过,已撤 —— 那是横切外推,
    // 被考卷当场判为「声明了做不到」:#3889 的官方证据里 droid 的 todo 状态是 **none**(仅UI无结构化事件),
    // 即厂商这一端根本不产出结构化 plan 事件,咕咕的 decode 再全也无从收起。
    // ❌ 措辞注意:整条落回基类 = 咕咕没接通;不许改写成 `none + unsupported-channel` 替厂商下结论。
    // agent memory:下面 `capabilities.memory` 登记的两条入口都走 `agents-md` 通道,宿主经
    // `AgentPluginHost.readMemoryFiles` 按声明读回。⚠️ 与 units/surfaces 无关 —— 读的是磁盘上
    // 用户自己写的文件,不需要一个活着的会话。
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

/**
 * droid 自己会去读的记忆文件。
 *
 * 出处:https://docs.factory.ai/cli/configuration/agents-md —— 官方页原文列出「project-level」
 * 从 cwd 逐级上溯到 git root 找 `AGENTS.md`(推荐名,另有 agents.md/Agents.md/CLAUDE.md 等兼容名),
 * 「personal」则在 home 下的 `~/.factory/` `~/.agents/` `~/.agent/` 里找同一族文件名。
 *
 * ⚠️ 只登记**推荐名**这一条路径,不把兼容别名铺开:同一目录下多个别名的加载优先级官方页只说
 * 「不要都建」,没给确定的顺序 —— 全登记会把「引擎实际读了哪一份」变成猜。少读是欠账,读错是假账。
 */
const droidMemory = {
  kind: 'files',
  entries: [
    // 相对 home:~/.factory/AGENTS.md
    { kind: 'file', scope: 'global', channel: 'agents-md', path: '.factory/AGENTS.md' },
    // 相对工作区根:仓根 AGENTS.md
    { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
  ],
} satisfies AgentMemoryDescriptor;

export const plugin = definePlugin(
  {
    id: 'droid',
    name: 'Droid',
    description: "Factory AI's agent CLI for running multi-step coding tasks from the terminal.",
    websiteUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
  },
  {
    sessionBundle,
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
      // ACP 档位表(session/new 自报 normal/spec/auto-low/auto-medium/auto-high)只声明有据的
      // 一档:auto-high = 完全访问(#4482/gugu-base@39b451b 的 droid 探针以 --auto high 全自动
      // 执行工具,TUI 侧同名档语义一致,见下方 buildCommand 注释)。其余档位在两轴上怎么落
      // (normal/spec/auto-low/auto-medium)没有读数,❌ 不猜 —— 缺席时分类器按启发式,
      // 不影响 full-access 的精确匹配。
      modes: {
        'full-access': { id: 'auto-high' },
      },
    },
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:factory 只提供 `app.factory.ai/cli` 这个安装脚本,没有带校验的版本化归档。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({ binaryNames: ['droid'] }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'unmeasured' },
    },
    memory: droidMemory,
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      resumeNeedsProviderId: true,
      // Context7 /websites/factory_ai documents `droid exec --fork <id>` as a
      // non-interactive prompt run, not Gugu's zero-input interactive fork lifecycle.
      // Keep fork undeclared until official docs cover that complete contract.
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  acp: createNativeAcpBehavior(() => ({
    args: ['exec', '--output-format', 'acp-daemon'],
    env: {
      DROID_DISABLE_AUTO_UPDATE: 'true',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
    },
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // Interactive `droid` only exposes `--auto <level>`; `--skip-permissions-unsafe`
        // is exclusive to `droid exec`. `high` grants the broadest autonomy the
        // interactive TUI supports (edits, installs, git push, deploys).
        autoApproveFlag: '--auto high',
        initialPromptFlag: '',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
      }),
  },
  hooks: buildDroidHookConfig(),
  mcp: droidMcpAdapter(),
  sessions: { validateProviderSessionId },
});
