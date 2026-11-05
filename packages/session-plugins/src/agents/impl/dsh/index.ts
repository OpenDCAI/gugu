import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import { MANAGED_NODE_VERSION, miseDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { icon } from './icon';
import { DSH_PERMISSION_MODES } from './permission-modes';
import { dshSessionBundleDescriptor, materializeDshSessionBundle } from './session-bundle';

const sessionBundle = dshSessionBundleDescriptor satisfies SessionBundleDescriptor;

/** `dsh --version` 打一行裸版本号,而它的版本全是预发布号(`0.2.1-rc.5`)。 */
const DSH_VERSION_LINE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s*$/;

/**
 * DeepSeek Harness —— DeepSeek 官方的开源 agent(MIT,github.com/deepseek-ai/deepseek-harness)。
 * 咕咕只接它的标准 ACP v1 profile(`dsh --profile acp`),不接 Web UI / TUI。调研与实测在 2026-11-05(gpu)。
 */
export const plugin = definePlugin(
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    description: "DeepSeek's open-source coding agent: reads the codebase, edits files, runs commands, and keeps long sessions.",
    websiteUrl: 'https://www.deepseek.com/en/harness/',
  },
  {
    sessionBundle,
    /** 自带 key 填 `DEEPSEEK_API_KEY`(或在 dsh 自己的凭据库里存);平台会话由咕咕给令牌。`initialize` 报 `authMethods: []`。 */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '0.2.1-rc.5 隔离 HOME:initialize authMethods [];session/new 不要凭据,没有 key 时模型目录为空、'
        + '请求报 MISSING_CREDENTIAL;给了 baseURL + key 请求落在给定网关(gpu 假网关实测,2026-11-05)',
    },
    // ACP `reasoning_effort`(category `thought_level`)的取值,逐字:off / low / high / max(session/new 实测)。
    effort: {
      kind: 'selectable',
      effortOptions: {
        off: { name: '关闭', description: '这一轮不做额外推理' },
        low: { name: '低', description: '快速回应，推理较浅' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
      },
    },
    acp: {
      kind: 'supported',
      /**
       * 2026-11-05 gpu 实测(0.2.1-rc.5,裸 ACP + 假网关):`session/set_config_option` 设 `model` /
       * `reasoning_effort` 都在应答里读回新值,下一轮请求就是新模型 ⇒ `acp-config-option` + `ack-read-back`。
       * 模型可以热切:平台会话的 `--patch` 把这条会话能切的咕咕模型全列进 dsh 的模型表。
       *
       * 权限 `reload-session`:dsh 自己的界面能在开着的会话里换档 —— Web 的权限下拉与 TUI 都走 `/permission <档>`
       * 命令(`dsh-client-ui-permission-presets` 调 `session.command('/permission …')`,命令处理在
       * `dsh-permission-presets`,当场改这条会话的 sandbox 与 approval)。但 ACP 面不带命令也不带 modes
       * (`dsh-acp` README「Unsupported surfaces … modes, commands」);实测 0.2.1-rc.5:prompt 里发
       * `/permission danger-full-access` 原样进了模型;`session/set_mode` 回 Method not found,
       * `set_config_option permission` 回 unknown option。
       * ⇒ 换档 = 带新档重起进程再 `session/resume`:咕咕插进 `--patch` 的插件在续接时调同一个 `permissionPresets.set`
       *   (见 ./permission-plugin.ts),上下文由 resume 保住。忙时拒绝:换档要重起进程,❌ 打断在飞的那一轮。
       *
       * 忙时一律 `reject`:dsh 一轮开始时钉住所选模型,改动落在下一轮(README),这一层没量过,❌ 先声明更松的。
       */
      liveSettings: {
        model: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
        permission: { channel: 'reload-session', ack: 'none', busy: 'reject', reloadRequired: true, recovery: 'runtime-restart' },
        effort: { channel: 'acp-config-option', ack: 'ack-read-back', busy: 'reject', reloadRequired: false, recovery: 'none' },
      },
    },
    autoApprove: {
      kind: 'supported',
      modes: DSH_PERMISSION_MODES,
      modesExhaustive: true,
    },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      // `dsh-mcp-client`:工具名 `mcp__<serverName>__<rawName>`。
      toolNames: { kind: 'listed', prefix: 'mcp__gugu__', evidence: '@deepseek-ai/dsh-mcp-client 0.2.1-rc.5 lib/index.js `mcp__${serverName}__${rawName}`' },
    },
    // 托管安装(npm backend):本体是 JS(`bin/dsh` → `lib/bin.js`),要 Node ≥ 24.9;咕咕托管的那份满足。
    hostDependency: { ...miseDependency({
      id: 'dsh',
      backend: 'npm',
      package: '@deepseek-ai/dsh',
      node: MANAGED_NODE_VERSION,
      installDocs: 'https://github.com/deepseek-ai/deepseek-harness',
    }), versionLine: DSH_VERSION_LINE },
    // 记忆文件 —— `dsh-agent-instructions`:`$DSH_HOME/AGENTS.md` 加项目里的 `AGENTS.md`(也读 `CLAUDE.md`)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.dsh/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    trust: { kind: 'none' },
    prompt: {
      kind: 'none',
      reason: 'Gugu offers DeepSeek Harness only as a Work (ACP) session; its Web UI and TUI are not offered.',
    },
    // 会话由 dsh 自己存(`$DSH_HOME/sessions`),`initialize` 报 `sessionCapabilities` list / resume / close,
    // 没有 loadSession:接回走 `session/resume`(不重放,历史在咕咕自己的库里)。
    sessions: { kind: 'resumable' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeDshSessionBundle, platformModel },
  // 会话级 argv(`--patch <文档>`)由物化器产出,经 `capabilityArgs` 挂在 `dsh --profile acp` 上。
  acp: createNativeAcpBehavior((ctx) => ({
    args: ['--profile', 'acp', ...(ctx.capabilityArgs ?? [])],
  })),
});
