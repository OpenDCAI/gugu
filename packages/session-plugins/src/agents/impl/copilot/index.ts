import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { buildCopilotHookConfig } from './hooks';
import { icon } from './icon';
import { copilotSubscription } from './subscription';
import { buildCopilotTrustBehavior } from './trust';
import {
  COPILOT_EFFORT_FLAG,
  copilotSessionBundleDescriptor,
  materializeCopilotSessionBundle,
} from './session-bundle';
import { copilotMcpAdapter } from './mcp';

export const plugin = definePlugin(
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    description:
      'GitHub Copilot CLI brings Copilot prompts to the terminal for code, shell, and search help.',
    websiteUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
  },
  {
    sessionBundle: copilotSessionBundleDescriptor,
    // 「订阅」页(product spec):套餐与本月额度经 `gh api /copilot_internal/user` 读(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 COPILOT_PROVIDER_TYPE/BASE_URL/API_KEY/MODEL_ID、零 GitHub 凭据，`copilot -p` exit=0 且 stdout 为端点回的内容。⚠️ 与它 README 的「An active Copilot subscription」「prompted to use /login」相反 —— 那句说的是用它自家模型',
    },
    /**
     * 推理强度 —— **一手实测**,不是照文档抄的。
     *
     * `copilot --help`(@github/copilot,2026-08-26 在隔离 HOME 下跑,零推理请求)原文:
     *   `--effort, --reasoning-effort <level>  Set the reasoning effort level`
     *   `(choices: "none", "minimal", "low", "medium", "high", "xhigh", "max")`
     * 七档逐字取自那行 choices,❌ 没有增删、没有「照别家补齐」。
     *
     * ⚠️ `none` 也是一档合法取值(不是「没有档位」)——它表示这一轮不推理。所以它进词表,
     *    ❌ 不因为名字叫 none 就当成缺省而丢掉。
     *
     * 活会话一旦起来,ACP 的 `thought_level` 会重新 advertise 真实可用档位,composer 切到那份;
     * 这里这张表是**读不到活目录时**的来源(见 harness-model-field 的 harnessCatalogToEfforts)。
     */
    effort: {
      kind: 'selectable',
      effortOptions: {
        none: { name: '关闭', description: '这一轮不做额外推理' },
        minimal: { name: '极低', description: '几乎不推理，最快' },
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
       * 只声明**量过的那一维**(三维各自声明,见 `LiveSettingsCapability`);permission / effort 没量,缺席 ——
       * 权限维一旦声明,启动时就会走 copilot 报的 mode 阶梯(agent/plan/autopilot),那是另一个命题。
       *
       * model = 热的,2026-09-22 mac1 实测(#6182),@github/copilot 1.0.82,裸 ACP 客户端 + 本地记录端点,
       * 读真正送出去的 `/v1/responses` body 的 `model`:
       * · 走自定义 provider(咕咕注入的 `COPILOT_PROVIDER_*`)时,`session/new` 的 `configOptions`
       *   只有 `mode` / `allow_all`,**一条 `model` 都不报**;但 `set_config_option {configId:'model'}`
       *   照收(内部 `session.model.switchTo`),下一轮 `glm-5.3` → `glm-5.3-flash`。
       *   空值当场 `-32602` 拒 ⇒ 「调用成功 = 已生效」成立,`ack` 如实;读不回(不报这一项),所以不是 `ack-read-back`。
       *   ⇒ 那个不报的 id 由 `configId` 声明出来。
       * · 重开**兑现不了**:按新模型重设 `COPILOT_PROVIDER_MODEL_ID` → `session/load` → 下一轮仍是 `glm-5.3`
       *   (copilot 恢复会话时回到会话自己记的模型)。⇒ ❌ 别声明成 `reload-session`。
       */
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          configId: 'model',
          ack: 'ack',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    autoApprove: {
      kind: 'supported',
    },
    // 与 `hooks.ts` 真装的边一致(#5922):errorOccurred → error、postToolUse(Failure) → wait_resolved。
    hooks: {
      kind: 'config',
      scope: 'workspace',
      supportedEvents: ['start', 'stop', 'session', 'notification', 'error', 'wait_resolved'],
    },
    // 托管安装:`@github/copilot` 的 npm 包只是个 loader,程序体在
    // `@github/copilot-<platform>-<arch>` 里(六格齐全,归档里是可执行文件 `copilot`)。
    // `versionLine`:`--version` 里它自己那一行,实测原样「GitHub Copilot CLI 1.0.105.」(下一行是 update 提示,包装器的 banner 在它前面)。
    hostDependency: { ...miseDependency({
      id: 'copilot',
      package: '@github/copilot',
      executables: {
        'darwin-x64': 'copilot', 'darwin-arm64': 'copilot',
        'linux-x64': 'copilot', 'linux-arm64': 'copilot',
        'win32-x64': 'copilot.exe', 'win32-arm64': 'copilot.exe',
      },
    }), versionLine: /^GitHub Copilot CLI / },
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'gugu-', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):~/.copilot 会话里的工具名 `gugu-message_reply`' },
    },
    /**
     * agent memory —— Copilot CLI **自己会去读**的自定义指令文件。
     *
     * 出处:https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
     * (取证 2026-08-24)。该页列出的位置:仓库侧 `.github/copilot-instructions.md`、
     * `.github/instructions` 下递归的 `.instructions.md`、`AGENTS.md`、`CLAUDE.md`
     * (含 `.claude/CLAUDE.md`)、`GEMINI.md`;用户侧 `$HOME/.copilot/copilot-instructions.md`
     * 与 `$HOME/.copilot/instructions` 下递归的 `.instructions.md`。
     *
     * ⚠️ 只登记其中三条,其余是有意留白:
     *  · ❌ `CLAUDE.md` / `.claude/CLAUDE.md` / `GEMINI.md` —— 别家的专名文件,登给 copilot 会让
     *    同一份文件在多家的读数里重复出现,分不清是谁的记忆;
     *  · ❌ 两个 `instructions` 目录 —— 文档写的是递归匹配,而 `AgentMemoryEntry` 的
     *    directory 形态只收顶层,登记它等于只读回一部分却报成全部。已知欠账。
     * ⚠️ `COPILOT_HOME` 被改过时 global 那一条会读到空(宿主的 fs 恒锚在 home,声明表达不了
     * 环境变量)。同样是已知欠账,不是错登记。
     * ⚠️ `satisfies` 不是装饰:capability schema 钉的是 `z.ZodType<AgentMemoryDescriptor>`,
     * zod 4 把 Input 留成 `unknown`,少这一句这段声明在类型上不受检。
     */
    memory: {
      kind: 'files',
      entries: [
        {
          kind: 'file',
          scope: 'global',
          channel: 'vendor-file',
          path: '.copilot/copilot-instructions.md',
        },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        {
          kind: 'file',
          scope: 'project',
          channel: 'vendor-file',
          path: '.github/copilot-instructions.md',
        },
      ],
    } satisfies AgentMemoryDescriptor,
    prompt: {
      kind: 'argv',
      flag: '-i',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
    trust: {
      kind: 'supported',
      // 写用户那份全局配置(见 capabilities/trust.ts 的 channel 注释)—— 沿用,未查运行时通道。
      channel: 'config-file',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializeCopilotSessionBundle, platformModel },
  subscription: copilotSubscription,
  // `copilot --acp` 就是执行工具的那个进程(没有独立 adapter),所以物化器为 ACP 腿产出的 argv
  // (平台会话的起始推理档 `--effort`,由宿主方言物化器产出、经平台 adapter-env 信封递进来)只能挂在这里。
  // 不挂 = 物化报告写着 loaded、进程一个字节没收到(#6218:平台模型的推理档因此到不了网关)。
  acp: createNativeAcpBehavior((ctx) => ({
    args: ['--acp', ...(ctx.capabilityArgs ?? [])],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag: '--allow-all-tools',
        // `--effort <level>` —— `copilot --help` 原文(@github/copilot,2026-08-26 实测)。
        // ❌ 不接这一格的话,用户在 composer 选的档位到不了进程:picker 看着能用、实际是空操作。
        effortFlag: COPILOT_EFFORT_FLAG,
        initialPromptFlag: '-i',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
      }),
  },
  hooks: buildCopilotHookConfig(),
  mcp: copilotMcpAdapter(),
  trust: buildCopilotTrustBehavior(),
});

export {
  COPILOT_ACP_SOURCE,
  COPILOT_ACP_VERSION,
  copilotSessionBundleDescriptor,
  materializeCopilotSessionBundle,
} from './session-bundle';
