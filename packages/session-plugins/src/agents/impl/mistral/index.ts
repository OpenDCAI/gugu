import { dirname, extname, join } from 'node:path';
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
import { buildMistralHookConfig } from './hooks';
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
  coexistence: {
    // 四条都由 ACP 腿提供(`surfaces` 含 'acp',本文件 provider.acp =
    // createNativeAcpBehavior(vibe-acp)),与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:acp/models/session.ts 的 'cancelling' 相 → acp/models/turns/turn.ts 的
    //    cancelled 出口。进程留着、会话还在,是**暂停**不是停止。
    //  · 在飞:session-runtime/src/acp-agents/machine/machine.ts 的 projectSessionState 产出
    //    isGenerating / canCancel / lifecycle;turn 侧有 startedAt + outcome 结算。
    //  · 问人:走**授权型**——cell.ts 的 requestPermission → resolvePermission,
    //    pendingPermissions 由 session-chat-ui/src/state/chat-state.ts 的 setPermissions 递到界面。
    //    ❌ 澄清型(mcp-elicitation / native-tool)咕咕没通,不在此声明 —— 本目录 hooks.ts 那条
    //    钉 ask_user_question 的 before_tool 只是往咕咕推一个 permission_prompt 通知,不是问答通道。
    //  · plan:acp/reducer/decode.ts 解出 { kind:'plan', entries } 后折进 transcript。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // 记忆文件读得到:本文件 capabilities.memory 登记了两条 AGENTS.md 入口(出处见那一段),
    // 宿主经 AgentPluginHost.readMemoryFiles(plugin-host.ts:270)按登记逐条读回。
    // 那条路读的是磁盘、不需要会话,故与 ACP/TUI 两条腿都无关。
    // ⚠️ channel 必须与 capabilities.memory 登记的通道同名。
    memory: { kind: 'native', channel: 'agents-md' },
    /**
     * 读侧自省 —— 走**运行中的引擎**(ACP 腿),不是扫配置文件。
     *
     * ⚠️ 这一条推翻了本文件上一版写的判据。上一版写的是「判据是『注册了 behavior.mcp 且
     * capabilities.mcp 为 supported』,mistral 两者皆无」—— 那个判据只覆盖 `config-scan`
     * 这一个 channel,把 `running-engine` 那一半漏掉了。同样的通路 auggie 已经在用
     * (impl/auggie/session-bundle.ts 的 introspection 段)。
     *
     * 咕咕这一侧是通用装配、不分家:`available_commands_update` 这条 session/update 经
     * `session-core/src/acp/reducer/decode.ts:260` 解出 → `reducer.ts:511-525` 写进
     * `config.availableCommands` → `apps/desktop/src/session/renderer/features/sessions/acp/
     * acp-chat-store.ts:196` 的 `get commands()` 摆进 composer 的命令列表。
     *
     * mistral 这一侧确实发,且发的是**用户自己的**东西 ——
     * mistralai/mistral-vibe@a84be0391bf93e93a4025a5e08e8032ecb587123:
     *  · `vibe/acp/commands/controller.py:66-86` `send_commands()`:内建命令之外,还把
     *    `session.app_server.resources.runtime.skills` 里每个 `skill.user_invocable` 的 skill
     *    也拼进 `AvailableCommand` 列表,一起 `session_update(update=update_available_commands(...))`;
     *  · 那些 skill 来自用户自己的磁盘 —— `vibe/core/skills/manager.py:71-82` 的
     *    `_compute_search_paths` 收 `config.skill_paths` + `mgr.project_skills_dirs` +
     *    `mgr.user_skills_dirs`,即 `.vibe/skills/` `.agents/skills/` `~/.vibe/skills/`
     *    `~/.agents/skills/`(`vibe/core/skills/builtins/vibe.py:871-874` 逐条列了这四个)。
     *    咕咕从不往这些目录写东西,所以读回来的一定不是咕咕注进去的。
     *  · `vibe/acp/commands/registry.py:32` 的 docstring 亦自证:"Command advertised to ACP
     *    clients via available_commands_update"。
     *
     * ⚠️ 如实记下不完整的那一半:这张表里**内建斜杠命令那一段是厂商固定的**
     * (`registry.py:73-138` 的 `_build_commands()`),只有 skills 那一段是用户的。
     * 所以这是「报得出用户自己那部分」,不是全量 dump。
     * ❌ 不许因此改成 `config-scan`:咕咕没给 mistral 注册任何 MCP/配置适配器,扫不动磁盘。
     */
    introspection: { kind: 'native', channel: 'running-engine' },
    // 其余两维落回基类。一处**看着像接通、实则不是**,别再来一遍:
    //  · 本目录 hooks.ts 建出的 readHooks 只报咕咕自己注进去的 GUGU_HOOK_MARKER 哨兵,
    //    从不枚举用户自己写的 hook —— 撞基类那条「读咕咕注的 ≠ 读用户自己的」。
    //    上面那条 introspection 靠的不是它,是 ACP 腿。
    //  · history:core 的 `transcriptSources/` 注册表当前只有 claude-code 与 codex 两份 spec。
    //    接通它 = 在那里加一份 spec 并登记进 TRANSCRIPT_SOURCE_IDS,不是在这里改一行声明。
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'mistral',
    name: 'Mistral Vibe',
    description:
      'Mistral AI terminal coding assistant with conversational codebase help, execution tools, and file operations.',
    websiteUrl: 'https://github.com/mistralai/mistral-vibe',
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
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['notification', 'stop'],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'mistral-medium-3.5': {
          name: 'Mistral Medium 3.5',
          description: 'Default hosted Mistral Vibe model with high thinking and image support.',
          modelFeatures: { intelligence: 5, speed: 4 },
        },
        'devstral-small': {
          name: 'Devstral Small',
          description: 'Lower-cost hosted Devstral model for faster coding tasks.',
          modelFeatures: { intelligence: 3, speed: 5 },
        },
        local: {
          name: 'Local Devstral',
          description: 'Local llama.cpp Devstral model configured by Mistral Vibe.',
          modelFeatures: { intelligence: 3, speed: 3 },
        },
      },
    },
    // agent memory —— Mistral Vibe 走 AGENTS.md 分层(用户层一份、项目层沿 cwd 往上逐层收)。
    // 逐条出处(mistralai/mistral-vibe@a84be0391bf93e93a4025a5e08e8032ecb587123):
    //  · `vibe/core/paths/conventions.py` —— `AGENTS_MD_FILENAME = "AGENTS.md"`,全仓只此一个文件名。
    //  · `vibe/core/config/harness_files/_harness_manager.py` —— `load_user_doc()` 读
    //    `VIBE_HOME.path / AGENTS_MD_FILENAME`;`_collect_agents_md()` 从 cwd 向上逐目录读同名文件。
    //  · `vibe/utils/paths.py` —— `_DEFAULT_VIBE_HOME = Path.home() / ".vibe"`(`VIBE_HOME` 环境变量可改)。
    //  · 佐证:`vibe/core/system_prompt.py` 把两层分别渲染成「Contents of {VIBE_HOME}/AGENTS.md
    //    (user-level instructions)」与「Contents of {doc_dir}/AGENTS.md」。
    // ⚠️ 项目层是**向上走**的,咕咕这一侧只读工作区根那一份 —— 更外层的祖先目录锚不到
    //    project fs 的 root 里(local-plugin-fs.ts 的 resolveSafe 对越界路径直接抛)。少读不是错报。
    // ⚠️ `satisfies` 见 memory.ts 的说明:schema 钉的是 `z.ZodType<…>`,漏了这句本段不受类型检查。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.vibe/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:mistral 的发行物在 GitHub Releases(`mistral.ai/vibe/install.sh` 去那儿取),不在 npm 上。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({ binaryNames: ['vibe'] }),
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
  acp: createNativeAcpBehavior((ctx) => {
    const ext = extname(ctx.cli);
    const acpExt = ['.exe', '.cmd', '.bat', '.ps1'].includes(ext.toLowerCase()) ? ext : '';
    return {
      command: join(dirname(ctx.cli), `vibe-acp${acpExt}`),
      args: [],
    };
  }),
  hooks: buildMistralHookConfig(),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--agent auto-approve',
        initialPromptFlag: '',
        extraEnv: ctx.model ? { VIBE_ACTIVE_MODEL: ctx.model } : undefined,
      }),
  },
});
