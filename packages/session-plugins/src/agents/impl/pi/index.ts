import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type AgentMemoryDescriptor,
} from '@gugu/session-core/agents/plugins';
import {
  MANAGED_NODE_VERSION,
  buildStandardCommand,
  createFileDropPlugin,
  miseDependency,
  passthroughMcpAdapter,
} from '@gugu/session-core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { requireBridgeEntry } from '../../helpers/acp-bridge-entry';
import { NODE_WITH_IMPORT_ATTRIBUTES, resolveNodeInterpreter } from '../../helpers/node-interpreter';
import { parsePiHookEvent } from './hooks';
import { PI_EXTENSION_CONTENT } from './plugin-file';
import { buildPiTrustBehavior } from './trust';
import {
  materializePiSessionBundle,
  PI_GUGU_EVENT_MODULE_PATH,
  piSessionBundleDescriptor,
  PI_HOME_MCP_RELATIVE,
  PI_HOME_AGENTS_MD_RELATIVE,
} from './session-bundle';
import { icon } from './icon';
import { piSubscription } from './subscription';

export const plugin = definePlugin(
  {
    id: 'pi',
    name: 'Pi',
    description:
      'Minimal terminal coding agent with multi-provider model support and extensible custom tools.',
    websiteUrl: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent',
  },
  {
    sessionBundle: piSessionBundleDescriptor,
    // 「订阅」页(product spec):Pi 本身免费，读 `/login` 登了哪几家;不报余量(./subscription.ts)。
    subscription: { kind: 'supported', usageRefresh: 'on-open' },
    /** Pi's ACP adapter has no live catalog during task creation; keep this in sync with its six ACP thought levels. */
    effort: {
      kind: 'selectable',
      effortOptions: {
        off: { name: '关闭', description: '这一轮不做额外推理' },
        minimal: { name: '最低', description: '只做必要的简短推理' },
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
      },
    },
    acp: {
      kind: 'supported',
      // Pi repeats thinking levels in stable `modes` and thought_level config; only the latter is effort.
      sessionModes: 'none',
      /**
       * ## permission / effort 两维是**热的** —— 这一格是量出来的,不是声明出来的
       *
       * 这三维原本整块写着 `reload-session`,而那句话是在 pi 的 ACP 腿还不存在
       * (`kind:'none'`)的时候写下的 —— 腿有了之后**没有人回头量过**。
       * 代价是产品给用户指了一条死路:切 thinking 时它说
       * 「The current session must be explicitly restarted before the new mode can apply.」
       * 而那句话里点不到任何东西(#5556,owner 2026-09-13 亲手撞到)。
       *
       * 实测(2026-09-13,mac1,pi 0.85.1 + pi-acp 0.0.33,裸 ACP 客户端,**同一条活会话**、
       * 不重启不恢复;行为臂读的是**真正送出去的那份上游载荷**里的 `reasoning_effort`,
       * ❌ 不数思考块;阳控先钉 high 证明记录端点确实看得见该字段):
       * · pi-acp 把 thinking 的六档(off/minimal/low/medium/high/xhigh)**同时**报在两处 ——
       *   `session/new` 的 `modes`(⇒ 咕咕的 permission 维,走 `session/set_mode`)
       *   和 `configOptions[category=thought_level]`(⇒ 咕咕的 effort 维,走 `set_config_option`);
       *   两条**各量一次**,都热:
       *   - effort 路:low→线上 `low`,high→`high`,再 low→`low`(回来了),off→**字段消失**;
       *   - permission 路:medium→`medium`,off→**字段消失**,high→`high`。
       *   序列刻意**非单调** ⇒ 回合序号解释不了这种来回,只有「跟着我设的那个值走」解释得了。
       * · 两个入口**互相跟**:任一路改完,另一路的上报值同步(pi-acp 两条路都会发
       *   `config_option_update` 与 `current_mode_update`)。
       *
       * ⚠️ `xhigh` 在线上出现为 `high` —— 那是 **pi 自己的 clamp**(`thinkingLevelMap` 缺省回落),
       * ❌ 不是「没生效」。判据只用会原样透传的四档(off/low/medium/high)做等值比较;
       * 第一版判据把 xhigh 当 verbatim,于是**把一次真的热切判成了 NOT-HOT**。
       *
       * ⚠️ `ack: 'ack-read-back'` 是有意选最严的那一档:两维都实测读得回来,所以「提供者悄悄
       * 没生效」必须响亮失败(`cell.confirmSettingResponse` 会据此拒),❌ 不要降成 `'ack'`。
       *
       * ## model 那一维同样是**热的** —— 2026-09-22 量过(#6182),此前那格 `reload-session` 是没量过的声明
       *
       * pi-acp 在 `configOptions` 里报 `model`(值是 `gugu-platform/<id>`,整组平台模型都在,
       * 因为 models.json 就是整组写的),`set_config_option {configId:'model'}` 直达 pi RPC `set_model`;
       * 应答里的 `configOptions` 带回新的 `currentValue` ⇒ `ack-read-back` 兑现得了。
       * 实测(mac1,pi 0.85.1 + pi-acp 0.0.33,裸 ACP 客户端 + 本地记录端点,读**真正送出去的**请求
       * body 的 `model`):同一条活会话 glm-5.3 一轮 → 设 `gugu-platform/glm-5.3-flash` → 下一轮 `glm-5.3-flash`。
       *
       * ⚠️ 而「只能重开」在 pi 身上**根本兑现不了**:pi 恢复会话时优先用**会话文件里记的模型**
       * (`dist/core/sdk.js` 的 restore 分支),settings 的 `defaultModel` 只在恢复不出来时才生效。
       * 同一台装置实测:按新模型重写 settings → `session/load` → 下一轮仍是 `glm-5.3`。
       * 这正是 #6182 里「确认重启后账本仍是旧模型」的机制。⇒ ❌ 别把这一维改回 `reload-session`。
       */
      liveSettings: {
        model: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
        permission: {
          // pi 的档位只来自**稳定版** `session/new.modes`(实测 `configOptions` 只有
          // `model` 与 `thought_level` 两项、**没有** category=mode)⇒ 这一维的 configId 恒为 null,
          // 通道就是稳定版 `session/set_mode`。写明 `acp-mode` 而不是靠 cell 里那条
          // 「permission + 无 configId + acp-config-option ⇒ 改走 acp-mode」的自动换道:
          // 声明该说它实际走的那条路。
          channel: 'acp-mode',
          // ⚠️ 这里**不能**写 `ack-read-back`,尽管这一维实测读得回来 ——
          // `acp-mode` 那条路在 `cell.applyLiveSetting` 里调完 `setSessionMode` 直接
          // `ok({status:'applied'})`,**不经过** `confirmSettingResponse` ⇒ 读回根本没人核。
          // 写上就成了一句代码不兑现的声明,而「自相矛盾的声明表」正是这次要修的那类事故
          // (同一份表里 `channel` 说热、`startupOnly` 说只能启动时设,已有前例)。
          // pi 侧的确认是:未知档位它当场 `invalidParams` 抛(`isThinkingLevel` 校验),
          // 调用成功即已应用;read-back 随后以 `config_option_update` 广播过来。
          ack: 'ack',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
        effort: {
          channel: 'acp-config-option',
          ack: 'ack-read-back',
          busy: 'reject',
          reloadRequired: false,
          recovery: 'none',
        },
      },
    },
    /**
     * Pi 1.3.0 内置 MCP,读取全局 `<Pi agent dir>/mcp.json`。
     *
     * 键名 `mcpServers`,与 canonical 形状一致 ⇒ passthrough。
     * 两种 transport 都收:同一份 README 的条目形状里 stdio 走 `command`/`args`/`env`,
     * HTTP 走 `url`,本仓 ACP/TUI 两条腿的会话级声明也都实测过这两种。
     * ⚠️ ❌ 不写成用户的项目 `.mcp.json`:那是用户与团队共享的文件,设置页只读它、不该往里写。
     */
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
      toolNames: { kind: 'listed', prefix: 'mcp__gugu__', evidence: '@earendil-works/pi-coding-agent@1.3.0 dist/extensions/mcp/tools.js createMcpToolName; dist/core/mcp-servers.js mcpNamespace' },
    },
    /**
     * ## 回合的**起始边**在这里声明 —— 缺了它,终端腿的状态点只在会话出生那一下红,之后再也不红
     *
     * 这一维原本只有 `['session','stop']`。TUI/PTY 腿对「这一轮在不在跑」的**全部**知识来自
     * harness 打回的边沿事件(spec `hook-status-derivation`:「能报结束就必须能报开始」)。
     * owner 2026-09-14 亲手撞到:「pi 的终端它是连运行状态都出不来了」。
     * #5438(qwen TUI)/ #5509 是同一家族的前两例,修法同形:**补在宿主那个唯一写入者的输入上**,
     * ❌ 不在渲染层、❌ 不按家做特例。
     *
     * ⭐ **产品面实测(base 271ffaa7f6,mac1,判据只看 `av-status` 类名)**,同一个元素、同一家、同一形态:
     *   · **第一句**(建会话那一发):会话行一出现就带 `av-status--running`,409ms 亮,整轮 77.8s 亮着,
     *     82.9s 落回 —— 但那一下**不是**回合边沿,是 [[session-initial-status]] 的**状态出生**
     *     (`hasInitialWork` ⇒ 生下来就是 working);
     *   · **之后每一轮**:咕咕投递两格(39.2s / 44.3s 的真回合)+ 用户自己在会话页终端里敲一格(41.3s),
     *     **三格全程 `av-status--idle`**,一次都没到运行侧;
     *   · 同一 build 的阳控:qwen(#5509 给它补过原生 start 边)同一条投递路 **817ms 就红**、100.9s 落回。
     * ⇒ 这解释了那条看起来矛盾的旧读数(「pi 的 Code/TUI 腿 E1=+0.60s 显示运行中」):
     *   **它量的是会话出生那一格**,而 owner 是在一条**已有**的会话里说话 ⇒ 他只可能看到第二种来源。
     *   两个读数都为真,读的是**两个不同的 working 来源**。
     *
     * ⚠️ 宿主确实还有一条推断:`agent-hook-service.ts` 的 `providerSupportsNativeStartHook()` 为假时,
     * 从 `session:input-submitted` 合成一个 start。**它没有救下任何一格** ——
     * 咕咕投递不经过它(注入走 `keystroke-injection.ts` 的 `pty.write()` 直写,不过 `ptyController.sendInput`),
     * 而「用户自己敲」那一格按代码**应该**经过它、实测却照样是 idle;**为什么没红我没查到底,记为未测**。
     * ⇒ 不拿它当这条义务的替代品:声明 `'start'` 顺带把那条推断路关掉,而实测它本来也没在产出可见状态。
     *
     * 键名与出处见 `plugin-file.ts` 里 `pi.on('agent_start')` 那一段(逐字取自 pi 自己的
     * 事件清单,❌ 不凭记忆:拼错的键 pi 不报错、永不触发,而代码看起来是修好的)。
     */
    // 失败 / 等 ctx.ui 提示的边由同一个事件模块报(#6448;字段见 `hooks.ts` 的 parsePiHookEvent)。
    hooks: {
      kind: 'plugin',
      scope: 'workspace',
      supportedEvents: ['session', 'start', 'stop', 'error', 'wait', 'wait_resolved'],
    },
    // 托管安装(npm backend):纯 JS(bin `dist/bundle/cli.js`)+ 19 个运行期依赖 ——
    // 依赖树正是 aube 的活。
    hostDependency: miseDependency({
      id: 'pi',
      backend: 'npm',
      package: '@earendil-works/pi-coding-agent',
      node: MANAGED_NODE_VERSION,
    }),
    // agent memory —— pi 管这一族叫 **context files**,启动时自动加载。
    // 出处:https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
    //      (earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477)的「Context Files」一节
    //      原文「Pi loads `AGENTS.md` or `CLAUDE.md` at startup from: `~/.pi/agent/AGENTS.md` for
    //      global instructions / parent directories, walking up from the current working directory /
    //      the current directory」。同文件「Options」表另有 `--no-context-files` 可整体关掉。
    // ⚠️ 项目层是**向上走**的,咕咕只读工作区根那一份 —— 更外层锚不进 project fs 的 root
    //    (local-plugin-fs.ts 的 resolveSafe 对越界路径直接抛)。少读不是错报。
    // ⚠️ 故意**不**登记 `CLAUDE.md`(Claude Code 兼容回退)与 `AGENTS.override.md`(同节:某目录
    //    有它就顶替该目录的 AGENTS.md/CLAUDE.md):前者会把用户的 Claude 记忆显示成「pi 的记忆」,
    //    后者是条件顶替,两者都要先定「回退/顶替入口怎么标注」才谈得上登记。
    // ⚠️ ❌ 别把 `~/.pi/agent/SYSTEM.md` / `.pi/SYSTEM.md` 算进来:同文档「System Prompt Files」
    //    写明那是**替换系统提示**,不是 agent 的记忆;它对应的是 units.promptBlocks 那一格。
    // ⚠️ `satisfies` 见 memory.ts 的说明:schema 钉的是 `z.ZodType<…>`,漏了这句本段不受类型检查。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: PI_HOME_AGENTS_MD_RELATIVE },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    plugins: {
      kind: 'file-drop',
      scope: 'workspace',
    },
    trust: { kind: 'supported', channel: 'runtime-argv' },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      resumeNeedsProviderId: true,
      // Context7: /websites/pi_dev documents `pi --fork <path|id>` as forking
      // an existing session into a new session file.
      fork: 'supported',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  sessionBundle: { materialize: materializePiSessionBundle, platformModel },
  subscription: piSubscription,
  acp: {
    // pi 的 ACP 腿由 adapter `pi-acp` 提供(它自己再起 `pi --mode rpc`):咕咕维护的构建 @gugu-acp/pi-acp
    // (上游 + 源码补丁,shuxueshuxue/gugu-acp),按别名装在 pi-acp 下;入口由宿主解析(#6394),pi 暂不按
    // CLI 版本配对。⚠️ 用随包的那一份,❌ 不用 `npx pi-acp` —— 那条 launcher 路径正是这条腿当年被摘掉的原因
    // (每次会话现拉网络、版本不钉、离线即死)。
    bridge: { kind: 'package', alias: 'pi-acp', entry: 'dist/index.js' },
    buildSpawn: (ctx) => ({
      // adapter 是一份 JS,拿**这个进程里、这一刻**解析出的 node 起它 —— 与 claude 那条腿同一条纪律。
      command: resolveNodeInterpreter({
        require: NODE_WITH_IMPORT_ATTRIBUTES,
        purpose: 'pi 的 ACP adapter',
      }).command,
      args: [requireBridgeEntry(ctx, 'pi')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        // ⚠️ **必须钉**:pi-acp 解析 pi 可执行文件时只认 PATH 上的裸 `pi`,不钉就是让它去撞
        //    用户 PATH 上的另一个 pi(或者根本没有 —— 那时它响亮报 ENOENT,不静默回落)。
        //    与 claude 的 CLAUDE_CODE_EXECUTABLE 同一格。
        PI_ACP_PI_COMMAND: ctx.cli,
      },
    }),
    connect: (io, toClient) => connectStdioAcp(io, toClient),
  },
  mcp: passthroughMcpAdapter(PI_HOME_MCP_RELATIVE),
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        initialPromptFlag: '',
        // #6246: the own-model pick on the terminal leg (`provider/id`, e.g. `mine/own-a`, straight from the
        // catalog pi reports for this leg). pi's `--model` takes that form (`pi --help`: "supports
        // provider/id"). Without it the pick was never delivered and pi ran its own default. Platform
        // sessions carry no `config.model` and get `--provider gugu-platform --model` from the bundle.
        modelFlag: '--model',
        resumeFlag: '--session',
        cliSessionIdFlag: '--session',
        cliSessionIdOnResumeOnly: true,
        // Pi exposes fork as a positional-id command rather than resume + a flag.
        forkCommand: '--fork',
      }),
  },
  // 事件模块 POST 的 body 由咕咕自己定义(stop 的 outcome、wait 的 waitKind / waitId),按那份协议读回。
  hooks: { parseHookEvent: parsePiHookEvent },
  plugins: createFileDropPlugin({
    relativePath: PI_GUGU_EVENT_MODULE_PATH,
    content: PI_EXTENSION_CONTENT,
    legacyRelativePaths: ['.pi/extensions/emdash-hook.ts'],
  }),
  trust: buildPiTrustBehavior(),
});

export {
  materializePiSessionBundle,
  PI_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_EVENT_MODULE_PATH,
  PI_GUGU_PACKAGE_ID,
  PI_GUGU_PACKAGE_VERSION,
  piSessionBundleDescriptor,
} from './session-bundle';

export { PI_TRUST_ARGS, buildPiTrustBehavior } from './trust';
