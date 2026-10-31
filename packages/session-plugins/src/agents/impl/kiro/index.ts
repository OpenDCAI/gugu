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
import { buildKiroHookConfig } from './hooks';
import { icon } from './icon';

/** 见 `units.model` 抬头:查证后的终局,不是「还没查」。 */
const VENDOR_CLOSED_MODEL = {
  kind: 'none',
  degraded: {
    code: 'unsupported-channel',
    reason:
      'Kiro CLI 不说 OpenAI 协议：推理走 AWS CodeWhisperer RPC'
      + '（application/x-amz-json-1.0 + x-amz-target），模型 id 在 AWS 信封的 modelId 里，'
      + '且 settings 白名单已移除 endpoint 覆盖。⇒ 用户用自己的 Kiro 订阅额度，这是终局。',
  },
} as const;

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
    // ⚠️ 这一格是**终局,不是欠账** —— 别改回 UNVERIFIED_SESSION_BUNDLE_DELIVERY。
    //
    // owner 2026-08-25:「自有模型不可用的 agent harness 应该有一些。比如 kiro,
    //                     估计也是不能用自有模型。」查了,他是对的。
    //
    // 2026-08-25 实测(Kiro CLI 2.19.1,隔离 HOME/KIRO_HOME,全程假 key、未登录、零额度消耗;
    // 详见答案键 modelAccess 那一格):
    //  · 它**压根不说 OpenAI 协议** —— MITM 解密后的真实报文是 AWS JSON1.0 +
    //    `x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`,
    //    模型 id 藏在 `conversationState.currentMessage.userInputMessage.modelId`,
    //    不是 OpenAI 的顶层 `model`;
    //  · 981MB 二进制里 `/v1/chat/completions` `/v1/responses` `/v1/models` 合计 **0 命中**,
    //    同一把尺子能查到 `/account/usage` 等真实路径作阳性对照 ⇒ 这个 0 是真阴性;
    //  · settings 是封闭白名单,`api.endpoint` 一类一律 `not a valid setting`;
    //    开源前身 amazon-q-developer-cli 里那个用户级 endpoint 覆盖,在闭源版**已被移除**。
    // ⇒ 比 cursor 更彻底:cursor 至少有 `--endpoint`(只是指向私有 Connect-RPC),
    //   Kiro 连覆盖点都没了。不存在一个「被锁住等人去开」的 OpenAI 开关。
    model: VENDOR_CLOSED_MODEL,
    autonomy: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
    promptBlocks: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  },
  extension: UNVERIFIED_SESSION_BUNDLE_DELIVERY,
  /**
   * TUI 腿的中断键 —— **Esc,单按**。
   *
   * 出处是厂商自己的键位表 https://kiro.dev/docs/cli/terminal-ui/(取证 2026-08-24),
   * ❌ 不是 #3889 的证据串(那一列是二手转述,已知会记反):
   *   | `Esc`    | Close panels, cancel agent, clear prompt queue |
   *   | `Ctrl+C` | Exit session |
   *   | `Ctrl+D` | Exit session (from chat input) |
   *
   * ⚠️ 所以 **❌ 绝对不能写 Ctrl-C**:在这一家它是**退出会话**。这正是答案键那句
   * 「Ctrl+C 歧义」背后的东西 —— 填错的代价是把用户正在跑的会话杀了、界面还报「已暂停」。
   * 单按 Esc 的失败方向可接受:没在跑时它关面板 / 清空待发队列,不动进程。
   *
   * ⚠️ 同页另说 `chat.keybindings.cancelStream` 等三项**可被用户改键**。本字段记的是**默认**键位;
   * 改过键的用户这条会失灵(表现为「没暂停」,不是「杀会话」)。真要跟随用户设置,得去读
   * `kiro-cli settings`,那是另一件事。
   *
   * ⚠️ 这里**不动** `coexistence.pause`:kiro 是双腿的家,pause 记 ACP 腿更强的 `protocol-cancel`,
   * 中断键只由本字段记录(判据见 core 的 `tuiInterruptSurfaceRequirement`)。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'https://kiro.dev/docs/cli/terminal-ui/ 键位表「Esc — Close panels, cancel agent,'
      + ' clear prompt queue」;同表「Ctrl+C — Exit session」故 ❌ 不可用 Ctrl-C;取证 2026-08-24',
  },
  coexistence: {
    // 四条都由 ACP 腿提供(`surfaces` 含 'acp',本文件 provider.acp =
    // createNativeAcpBehavior(['acp'])),与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:acp/models/session.ts 的 'cancelling' 相 → acp/models/turns/turn.ts 的
    //    cancelled 出口。进程留着、会话还在,是**暂停**不是停止。
    //  · 在飞:session-runtime/src/acp-agents/machine/machine.ts 的 projectSessionState 产出
    //    isGenerating / canCancel / lifecycle;turn 侧有 startedAt + outcome 结算。
    //  · 问人:走**授权型**——cell.ts 的 requestPermission → resolvePermission,
    //    pendingPermissions 由 session-chat-ui/src/state/chat-state.ts 的 setPermissions 递到界面。
    //    ❌ 澄清型(mcp-elicitation / native-tool)咕咕没通,不在此声明。
    //  · plan:acp/transport/decode.ts 解出 { kind:'plan', entries } 后折进 transcript。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    // ❌ 不声明 todo:acp-plan —— kiro **原生**确实有结构化 todo_list(答案键 todo 那格记 have),
    // 但断的是桥:同一份答案键的 observability 那格写着「ACP session/update(4种,无Plan)」,
    // 与 kilocode 的「ACP仅4种无plan」是同一句话。原生能力与经 ACP 拿得到的能力必须分两栏、
    // 不许互推(#3889 横向发现②),所以这一维落回基类。
    // memory:对应下面 `capabilities.memory` 登记的 steering 目录与仓根 AGENTS.md ——
    // 登记了文件,宿主 `AgentPluginHost.readMemoryFiles` 就真读得回来。
    // ⚠️ 通道取 `vendor-file` 而不是 `agents-md`:kiro 的主线是它自己的 steering
    // (`.kiro/steering/*.md`,CLI 上无条件全量加载),AGENTS.md 是它另外兼容的一支;
    // `UnitDelivery` 一维只能记一个 channel,所以记主线那条。两条都登记在下面,读侧都读得到。
    memory: { kind: 'native', channel: 'vendor-file' },
    // 其余四维落回基类。两处**看着像接通、实则不是**,别再来一遍:
    //  · introspection:判据是「注册了 behavior.mcp 且 capabilities.mcp 为 supported」,kiro 两者皆无。
    //    本目录 hooks.ts 建出的 readHooks 只报咕咕自己注进去的 GUGU_HOOK_MARKER 哨兵,
    //    从不枚举用户自己写的 hook —— 撞基类那条「读咕咕注的 ≠ 读用户自己的」。
    //  · history:core 的 `transcriptSources/` 注册表当前只有 claude-code 与 codex 两份 spec。
    //    ⚠️ kiro 的本地历史是 SQLite(~/.kiro/),通用层今天只实现了 jsonl 一条读取路径 ——
    //    接通它要先补 sqlite 那条(见 transcriptSource.ts 的 TranscriptStorageChannel 注释)。
  },
} satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'kiro',
    name: 'Kiro (AWS)',
    description:
      'Kiro CLI by AWS, focused on interactive terminal-first development assistance and workflow automation.',
    websiteUrl: 'https://kiro.dev/docs/cli/',
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
      supportedEvents: ['session', 'start', 'stop'],
    },
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    // 只认不装:kiro 只提供 `cli.kiro.dev/install`。
    // 咕咕的托管安装只认 npm 平台包(mise-distribution.ts 读的是 npm registry 元数据 +
    // 平台包的 sha512),厂商脚本装到哪儿、装的是哪个版本、字节对不对都在咕咕视野之外。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({ binaryNames: ['kiro-cli'] }),
    // agent memory —— kiro 的 steering 一族 + 它兼容的 AGENTS.md。
    // 出处:https://kiro.dev/docs/steering/(取证 2026-08-24)。原文要点:
    //  ·「On Kiro CLI, inclusion modes are not currently supported. All steering files in the
    //    `.kiro/steering/` directory are loaded automatically.」→ CLI 上是**无条件全量加载**,
    //    所以整目录登记(只收顶层 `.md`)。
    //  · 全局 steering 在 `~/.kiro/steering/`,workspace steering 在项目根 `.kiro/steering/`;
    //    两处冲突时 workspace 优先。
    //  · AGENTS.md 可放 `~/.kiro/steering/` 或 workspace 根,且「AGENTS.md files do not support
    //    inclusion modes and are always included.」
    // ⚠️ 子目录里的 AGENTS.md(官方说也会在项目子目录中发现)**没登记**:`AgentMemoryEntry`
    //    表达不了「整棵树递归找」,硬写一层是猜。少登记只是欠账。
    // ⚠️ 放在 `~/.kiro/steering/` 的 AGENTS.md 不另立条目 —— 它已经被上面那条 global 目录条目
    //    按 `.md` 后缀收进来了。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle(zod 4 的 ZodType Input 是 unknown)。
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'directory',
          scope: 'global',
          channel: 'vendor-file',
          path: '.kiro/steering',
          suffixes: ['.md'],
        },
        {
          kind: 'directory',
          scope: 'project',
          channel: 'vendor-file',
          path: '.kiro/steering',
          suffixes: ['.md'],
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
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
  sessionBundle: createUnverifiedSessionBundleBehavior(plugin.metadata.id, sessionBundle),
  acp: createNativeAcpBehavior(() => ({
    args: ['acp'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        defaultArgs: ['chat', '--agent', 'gugu'],
        autoApproveFlag: '--trust-all-tools',
        initialPromptFlag: '',
        resumeFlag: '--resume-id',
        cliSessionIdFlag: '--resume-id',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--resume',
      }),
  },
  hooks: buildKiroHookConfig(),
});
