import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  materializeQwenSessionBundle,
  qwenSessionBundleDescriptor,
} from './session-bundle';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  miseDependency,
} from '@gugu/session-core/agents/plugins/helpers';
import { qwenScopedMcpAdapter } from './mcp-scopes';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import { buildQwenHookConfig } from './hooks';
import { QWEN_PERMISSION_MODES } from './permission-modes';
import { icon } from './icon';
import { qwenSubscription } from './subscription';

const sessionBundle = qwenSessionBundleDescriptor satisfies SessionBundleDescriptor;
const qwenMcp = qwenScopedMcpAdapter();

export const plugin = definePlugin(
  {
    id: 'qwen',
    name: 'Qwen Code',
    description:
      "Command-line interface to Alibaba's Qwen Code models for coding assistance and code completion.",
    websiteUrl: 'https://github.com/QwenLM/qwen-code',
  },
  {
    sessionBundle,
    /**
     * 厂商账号是不是硬门槛 —— 判据与陷阱见 `capabilities/vendor-account.ts` 抬头。
     * 这一格是**实测**出来的，❌ 不收「文档写着」。
     */
    vendorAccount: {
      kind: 'not-required',
      evidence:
        '只给 OPENAI_BASE_URL/API_KEY/MODEL 三件套、零 Qwen 账号，`qwen -p` exit=0，假端点收到 chat/completions',
    },
    // 「订阅」页(product spec):照 Qwen 自己的阿里云预设认计费种类;余量只在阿里云控制台(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    acp: {
      kind: 'supported',
      /**
       * 只声明**量过的那一维**(三维各自声明,见 `LiveSettingsCapability`);effort 没量,缺席。
       *
       * model = 只能重开,而且重开**兑现得了** —— 2026-09-22 mac1 实测(#6182),qwen 0.24.4,
       * 裸 ACP 客户端 + 本地记录端点,读真正送出去的 chat/completions body 的 `model`:
       * · 热切不行:ACP 腿只注入 `OPENAI_*` 三件套,活会话的模型清单就只有那一条
       *   (`$runtime|openai|glm-5.3(openai)`),`set_config_option model=glm-5.3-flash` 被拒
       *   (`Model 'glm-5.3-flash' not found for authType 'openai'`),下一轮仍是 `glm-5.3`;
       * · 重开可以:按新模型重新物化 env → `session/load` 同一条会话 → 下一轮 `glm-5.3-flash`
       *   (qwen 恢复会话时跟随进程 env,不回到会话记忆里的旧模型 —— 与 pi / copilot 相反)。
       */
      liveSettings: {
        model: {
          channel: 'reload-session',
          ack: 'none',
          busy: 'reject',
          reloadRequired: true,
          recovery: 'runtime-restart',
        },
        /**
         * permission = `session/set_config_option {configId:'mode'}`,有回读 —— 2026-10-06 mac1 实测(#6953),
         * qwen 0.24.4,裸 ACP + #6221 的假端点:设 default 写文件问 1 次、设 yolo 不问写成、设 plan 被拦,
         * 响应里 `mode.currentValue` 都是设进去的那一档。
         * · busy = reject:一轮在跑时切档 qwen 当场收下、**当轮**就生效(这一轮后面的写文件已不再问),
         *   ❌ 写成 queue-next-turn(那是「下一轮才生效」)。
         * · 缺了这一维时,Work 会话除了完全访问一档都起不来,完全访问又悄悄停在 qwen 无 flag 的 `auto`
         *   (不在档位表里,人看不到也选不到)。选「编辑」按档位表落到 `default`(见 QWEN_PERMISSION_MODES)。
         */
        permission: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
          allowStartupDowngrade: true,
        },
      },
    },
    // ── auth：❌ 这一家不声明（#6100）─────────────────────────────────────────
    // 原先这里只登记了 `api-key`,而 `api-key` 在产品里**没有任何可达动作**:
    // `plugin-host.ts` 的 `buildLoginCommand` 只接 `cli-login`,咕咕也从来没有填 key 的界面 ——
    // 那段声明换不来一个能点的东西。cli-login 又写不了:qwen 的登录**子命令**没有一手证据,
    // 凭空写一个 `args: ['login']` 就是编。
    // ⚠️ 连带删掉的还有登录**态**判据(原 ./auth.ts 的 `qwenAuthStatus`):
    //    `checkAuthStatusUncached` 的闸是 `provider.auth.kind === 'none' ⇒ unknown`,
    //    descriptor 一走那个行为就永远跑不到 —— 留着就是下一个「有行为没声明」。
    // ⚠️ 它从来**不是**平台额度资格的来源:资格是 `./platform.ts` 的声明。删它不动任何资格。
    // 档位表带实测出处见 `permission-modes.ts` 的 QWEN_PERMISSION_MODES(#6221):没有 edit 档。
    autoApprove: {
      kind: 'supported',
      modes: QWEN_PERMISSION_MODES,
      modesExhaustive: true,
    },
    // hooks 住在终端腿那份 run-scoped 系统级 settings 副本里(与 MCP、平台模型同一份),
    // ❌ 不写用户的 `~/.qwen/settings.json`。qwen 把 system 层 hooks 与用户层**并列**装载,
    // 各事件的合并策略都是 concat —— 用户自己的 hooks 照常生效,咕咕的条目不进他的文件。
    hooks: {
      kind: 'config',
      scope: 'session',
      channel: 'session-env',
      evidence:
        'https://registry.npmjs.org/@qwen-code/qwen-code/-/qwen-code-0.24.4.tgz 包内'
        + ' packages/cli/src/config/settingsSchema.ts(hooks.<Event>.mergeStrategy=concat)、'
        + 'hook-settings.ts(systemHooks/userHooks 分层)、core Config.getSystemHooks()'
        + '(HookRegistry.processHooksFromConfig 先载 system 再载 user)。取证 2026-09-22',
      // 与 `qwenHookSpecs()` 真装的边一致(#5922):StopFailure → error、PermissionRequest → wait。
      supportedEvents: ['notification', 'start', 'stop', 'session', 'error', 'wait'],
    },
    // 托管安装(npm backend):纯 JS 入口(bin `cli-entry.js`),原生件(node-pty / clipboard)
    // 作为平台 optionalDependencies 由 aube 按本机挑。
    hostDependency: miseDependency({
      id: 'qwen',
      backend: 'npm',
      package: '@qwen-code/qwen-code',
      node: MANAGED_NODE_VERSION,
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'mcp__gugu__', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):~/.qwen/projects/*/chats 的 tool_search 结果 `mcp__gugu__message_reply`;逐个上表的前提是物化器送到 alwaysLoadTools(见 session-bundle.ts)' },
      // 会话通道与用户配置**合并**:ACP `session/new.mcpServers` 进 qwen 的 `assembleMcpServers`
      // 当 `cliMcpServers`,结果是 `{...settings, ...project, ...session}` —— 用户 `~/.qwen/settings.json`
      // 里那几台照常装载,同名时会话那台赢 ⇒ 咕咕不必也不该复述它们。
      // 实测(mac1,隔离 HOME,0.24.4 与 0.22.3 各一轮,stdio 探针 spawn 即落标记,#6178):
      //   settings 里 {u1, gugu} + session 递 gugu ⇒ 标记 [session-gugu, settings-u1];
      //   阴控 session 递 [] ⇒ [settings-gugu, settings-u1](settings 确实被读、标记机制通)。
      // ⚠️ 复述在这一家是纯亏损:同一份文件被读回来再声明一遍,文件里只要有一台与咕咕同名
      //    (#4589–#4898 那段时间咕咕自己写进去的 `gugu` 残留就是),会话包就撞同名断言、Work 起不来。
      sessionUserServers: 'inherit',
    },
    // agent memory —— qwen 的专名文件是 QWEN.md,并额外收编跨厂商的 AGENTS.md。
    // 出处:官方仓的用户文档
    // https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/memory.md
    // 那张表逐字写着三处:`~/.qwen/QWEN.md`(所有项目)/ 项目根 `QWEN.md`(全队)/
    // `.qwen/QWEN.local.md`(只你、只本项目),并注明「Qwen loads all of them when you start a
    // session」—— 是**并列全读**,不是取第一个,所以三条都登记。同页还写着「If your repository
    // already has an `AGENTS.md` file for other AI tools, Qwen reads that too」→ 第四条。
    // ❌ 不登记 `~/.qwen/projects/<project>/memory/`:那是 qwen **自己写**的 auto-memory,
    //    路径含 per-project 派生段,不是一条固定的相对路径,也不是用户手写的记忆文件。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'vendor-file', path: '.qwen/QWEN.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: 'QWEN.md' },
        { kind: 'file', scope: 'project', channel: 'vendor-file', path: '.qwen/QWEN.local.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    // 如实标缺:本家没有已知的「把工作区标成可信」的通道 —— 引擎自己问一次(或它压根不问)。
    // ⚠️ 这一格没有默认值(owner 2026-09-03「强类型,不存在灰色地带」):写出来的是一句
    //    说过的话,❌ 不是省略。真查到通道了就改成 `{ kind: 'supported', channel: … }`。
    trust: { kind: 'none' },
    prompt: {
      kind: 'argv',
      flag: '-i',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: {
    platformModel,
    materialize: materializeQwenSessionBundle,
  },
  subscription: qwenSubscription,
  acp: createNativeAcpBehavior(() => ({
    args: ['--acp', '--experimental-skills'],
  })),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        // 终端腿的档位 flag 全部从同一张档位表派生(#6221);edit 不在表里,composer 不摆、spawn 前已解析掉,
        // 所以这里没有 editFlag —— ❌ 别补一个:qwen 没有兑现得了 Edit 的档。
        autoApproveFlag: `--approval-mode=${QWEN_PERMISSION_MODES['full-access'].id}`,
        planFlag: `--approval-mode=${QWEN_PERMISSION_MODES.plan.id}`,
        readOnlyFlag: `--approval-mode=${QWEN_PERMISSION_MODES['read-only'].id}`,
        initialPromptFlag: '-i',
        resumeFlag: '--resume',
        cliSessionIdFlag: '--resume',
        cliSessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: '--continue',
      }),
  },
  hooks: buildQwenHookConfig(),
  mcp: qwenMcp,
});

export { materializeQwenSessionBundle };
