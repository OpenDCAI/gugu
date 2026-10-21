import { platformModel } from './platform-model';
import {
  definePlugin,
  registerPluginBehavior,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import type {
  AgentCommand,
  AgentMemoryDescriptor,
  CommandContext,
} from '@gugu/session-core/agents/plugins';
import { buildStandardCommand, recognisedDependency } from '@gugu/session-core/agents/plugins/helpers';
import { createNativeAcpBehavior } from '../../helpers/acp-stdio';
import {
  kimiSessionBundleDescriptor,
  materializeKimiSessionBundle,
} from './session-bundle';
import { KIMI_PERMISSION_MODES } from './permission-modes';
import { KIMI_LOGIN_METHOD_ID, kimiAuthStatus } from './auth';
import { buildKimiHookConfig } from './hooks';

/**
 * ⚠️ 这里原先还有一步 `injectKimiHooksIntoInlineConfig` —— 把 hook 配置当文本注进
 * `--config <文本>`。**Kimi Code 0.38.0 根本没有 `--config` 这个旗标**（实测：报错与瞎编一个
 * 旗标逐字同形 ⇒ 真阴性；那是旧产品 Python `kimi-cli` 才有的东西）。
 *
 * 它一直是**死代码**而不是崩溃：咕咕自己从不传 `--config`，那个函数只改**已存在**的
 * `--config` 参数，所以从来没命中过 —— 也就是说 hook 从来没经这条路注进去过，
 * 而且一声不吭。删掉它，免得下一个人以为这条通道是通的。
 *
 * ⚠️ **这段原来的末句是错的，2026-08-27 更正**：原文写「hook 的真通道是
 * `$KIMI_CODE_HOME/config.toml`（本目录 hooks.ts 走的就是那条）」—— 括号里那半句不成立。
 * `hooks.ts` 的 `KIMI_CONFIG_PATH` 是 **home 相对**的 `.kimi-code/config.toml`，而
 * `AgentPluginHost.fs` 三处构造点全是 `createLocalPluginFs(homeDir)` ＝ **真 OS home**，
 * 它跟不了 `KIMI_CODE_HOME`。两者从前不是同一份文件：咕咕把 `[[hooks]]` 写进用户真 home，
 * 会话却在合成 home 里读 —— hook 通道被切断且一声不吭。
 * 现在会话不再合成 home（见 session-bundle.ts 的 `KIMI_HOME_ENV`），两条路才第一次指向同一份
 * `~/.kimi-code/config.toml`。会话侧读的位置：
 * `MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
 * `packages/agent-core-v2/src/features/externalHooks/configSection.ts:8-21`
 * ＋ `app/config/configService.ts:530`（配置文件恒在 `resolveKimiHome(...)` 之下）。
 */
function buildKimiCommand(ctx: CommandContext): AgentCommand {
  const cmd = buildStandardCommand(ctx, {
    // 完全访问 = kimi 自己最松的一档 `--yolo`(ACP 同名档自报「Auto-approve everything」)。危险命令它仍会问 ——
    // 那是 kimi 自己的决定,见 permission-modes.ts 的 KIMI_PERMISSION_MODES。❌ 换成 `--auto`:那一档危险命令静默拒,更窄。
    autoApproveFlag: '--yolo',
    // ⚠️ 声明了三档就得产出三个**互不相同**的 argv，否则其中一档会静默变成另一档
    //    （不报错、不红别的用例，只在真机上表现为「选了这档却是那档的行为」）。
    //    `edit` 就是不加 flag 的默认态，所以 `plan` 必须有自己的旗标。
    // ⚠️ 这条只管 **TUI 腿**。ACP 腿上 `--auto`/`--yolo`/`--plan` 都是**静默 no-op**
    //    （实测：被接受、退出码 0、行为等于基线；阳性对照 `--permission-mode yolo` 会被拒，
    //     说明这条路确实会拒未知 flag ⇒ 它们是被吃掉而不是被拒）。ACP 那边走
    //     `session/set_mode` / `session/set_config_option`，由运行时按 modes 映射表下发。
    planFlag: '--plan',
    // resume 与新起一样推档位旗标。0.40.1 TUI 实测(假上游,`--plan` 起的会话):`-S <id>` 不带旗标仍是 plan
    // (kimi 恢复会话自己存的档);`-S <id> --plan` 照常;`-S <id> --yolo` 被接受且生效(页脚「Ask When Needed」,
    // 命令不问就跑)。⚠️ 编辑档没有旗标,所以 plan 会话 resume 成编辑档时 kimi 仍留在 plan —— 更严的方向。
    resumeFlag: '-S',
    cliSessionIdFlag: '-S',
    cliSessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: '-C',
  });
  return cmd;
}
import { icon } from './icon';
import { kimiMcpAdapter } from './mcp';

const sessionBundle = kimiSessionBundleDescriptor satisfies SessionBundleDescriptor;

export const plugin = definePlugin(
  {
    id: 'kimi',
    name: 'Kimi',
    description:
      'Kimi Code CLI by Moonshot AI, with an ACP server, skills, and plan mode.',
    websiteUrl: 'https://moonshotai.github.io/kimi-code/en/guides/getting-started',
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
        '只给 KIMI_MODEL_* 一族、零 Moonshot 凭据，请求打到假端点且换 key/换 model id 读数跟着变（变异对照）',
    },
    acp: {
      kind: 'supported',
    },
    /**
     * 推理强度 —— **已接通**(2026-08-28)。五档,出处是官方 `[models.*] support_efforts`
     * 与 `[thinking] effort` 的取值 `low/medium/high/xhigh/max`。
     *
     * ⚠️ 「要不要思考」(`[thinking] enabled`,咕咕默认开)与「思考多深」(本表)是**两个轴**,
     *    ❌ 别混 —— 这一格来回错过三次,三次都是把两个轴当成一个。
     *
     * ## 怎么送到的(实测,0.39.0,假上游接住 chat/completions 看 body)
     *
     * 咕咕把模型**整份写进自己那份 config.toml**(独立 home,见 session-bundle 的
     * `modelConfigOverlay`),带上 `support_efforts` ⇒ ACP 的 thinking 选项从
     * `off/on` 变成 `off/low/medium/high/xhigh/max`,上游 body 出现 `"reasoning_effort"`。
     * 每次会话的档位走 ACP `set_config_option({configId:'thinking'})`(咕咕那条
     * `applyInitialEffort` 通道本来就通着),实测切 `low`/`max`/`off` 下一轮 body 分别是
     * `"low"`/`"max"`/**没有该字段**,而 config.toml 一个字节没变。
     *
     * ## 三次错法留着,❌ 别重蹈
     *
     * ⚠️ ❌ **别拿 ACP `session/new` 的 `configOptions` 当档位清单** —— 那一格是**按模型能力
     *    动态暴露**的:没有 `support_efforts` 的模型上它退化成 `off/on`,读到的是**仪器状态**
     *    而不是这一家的能力。(阴性对照:env 注入的模型无论 config 里怎么写都恒是 `off/on`。)
     * ⚠️ ❌ 别用 `KIMI_MODEL_THINKING_EFFORT`:咕咕钉死 `PROVIDER_TYPE=openai`,那个 env
     *    在 openai provider 下根本不进上游请求体(四组变体全无命中)。
     * ⚠️ ❌ 更别用「env 写进 spawnEnv 了」当投递判据 —— 那验的是写没写,不是**到没到上游**。
     * ⚠️ ❌ 也别把 `migrations-effort.json` 里的 `thinking-effort-max-to-high` 当噪声排除掉,
     *    它恰恰是「真有 max/high」的旁证。
     */
    effort: {
      kind: 'selectable',
      effortOptions: {
        low: { name: '低', description: '快速回应，推理较浅' },
        medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
        high: { name: '高', description: '更深的推理，适合复杂问题' },
        xhigh: { name: '极高', description: '超高推理深度，适合疑难问题' },
        max: { name: '最高', description: '最大推理深度，留给最难的问题' },
      },
    },
    /**
     * 怎么登 —— 出处与三个分支的理由见 `./auth.ts`。
     *
     * ⚠️ 不声明这一格就是**真的没有登录入口**了(spec: harness-auth-surface,payload 只直通
     *    声明,❌ 不再兜通用方法):owner 2026-08-26 实测的缺口正是「说了需要先登录
     *    (Login with Kimi account),却没有把人带到能登录的地方」。
     *    声明真命令之后,那个入口跑的是 `kimi login` ——
     *    设备码流程自己把验证链接和用户码印出来。
     *
     * ❌ 不声明 `api-key` 方法:Kimi **不从环境变量读**凭据
     *    (`docs/en/configuration/env-vars.md:5-6` 原文:`KIMI_API_KEY` / `ANTHROPIC_API_KEY` /
     *    `OPENAI_API_KEY`「are **not** read automatically from shell environment variables」),
     *    摆一个填了不生效的表单就是 fake。`KIMI_MODEL_*` 那一族是**模型 provider**,不是 Kimi 账号。
     */
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: KIMI_LOGIN_METHOD_ID,
          // 逐字用它 ACP 自报的那句,与 composer 上「需要先登录(…)」括号里的字对齐。
          name: 'Login with Kimi account',
          args: ['login'],
          // 本来就是设备码登录(见 description),别的机器上原样可用。
          headlessArgs: ['login'],
          description:
            'Runs `kimi login`: a device-code sign-in that prints a verification URL and a user code, then waits for you to authorize it in a browser.',
        },
      ],
    },
    // 用户自己往这家装 MCP server 的通道（与咕咕**每会话**那条不是一回事 ——
    // 后者走 ACP `session/new`，零落盘，见 session-bundle.ts 的 units.mcp）。
    // ⚠️ 只声明 http：stdio 那一支本轮没验过，❌ 不把没验的形状说成支持。
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['http'],
      toolNames: { kind: 'listed', prefix: 'mcp__gugu__', evidence: 'mac1 harness 会话存档里模型实际调用的工具名(#6192 盘点,2026-09-23):<GUGU_HOME>/agent-homes/kimi/.kimi-code/sessions 的工具名 `mcp__gugu__message_reply`' },
    },
    autoApprove: {
      kind: 'supported',
      // 四档里咕咕只摆它真有的三格 —— 它没有「只读」（`plan` 是规划不是只读）。
      // 证据与那条静默 no-op 的 argv 陷阱见 `./permission-modes.ts`。
      modes: KIMI_PERMISSION_MODES,
    },
    // 写进咕咕托管的独立配置根(`injectionMode: 'managed-config-root'`),不是用户的 `~/.kimi`。
    hooks: {
      kind: 'config',
      scope: 'agent-home',
      supportedEvents: ['notification', 'stop', 'session', 'start'],
    },
    // 只认不装:kimi 的安装是厂商脚本(`code.kimi.com/kimi-code/install.sh`,装到
    // `$HOME/.kimi-code/bin/kimi`),而它在 npm 上的那份 `@moonshot-ai/kimi-code` 是纯 JS
    // (bin `dist/main.mjs`,带 ws/qrcode 运行期依赖、没有平台包)⇒ 两条路都拿不到
    // 可直接执行的归档(核于 2026-09-21)。
    // ⇒ 这一家由用户自己按厂商文档装,咕咕认那一份(#6098)。
    hostDependency: recognisedDependency({
      binaryNames: ['kimi'],
      installDocs: 'https://code.kimi.com',
    }),
    // agent memory —— kimi 读 AGENTS.md 系。
    // 出处:https://moonshotai.github.io/kimi-cli/en/customization/agents.html
    // (源文件 https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/agents.md,
    // 取证 2026-08-24)—— 系统提示内置参数 `${KIMI_AGENTS_MD}` 的原文:
    //  「Merged `AGENTS.md` content from project root to working directory
    //    (including `.kimi/AGENTS.md`)」。
    // ⚠️ 通道全部记 `agents-md`:分通道的判据是**文件名约定**不是所在目录 —— `.kimi-code/AGENTS.md`
    //    仍是 AGENTS.md 那一族(同 codex 把 `.codex/AGENTS.md` 记成 agents-md)。
    // ⚠️ 上面那段引的是**旧 kimi-cli** 的文档,已随 descriptor 一并钉到 Kimi Code。新产品的读法
    //    读自 `MoonshotAI/kimi-code@243f348329fc15e857dcaa0ae3cfe514729bd7a6`
    //    `packages/agent-core-v2/src/agent/profile/context.ts` 的 `loadAgentsMdForRoots`(`:137-196`):
    //     · global(`:159-169`):先 `$KIMI_CODE_HOME/AGENTS.md`(默认 `~/.kimi-code/AGENTS.md`),
    //       再 `~/.agents/` 下 `AGENTS.md` / `agents.md` **取首个命中**。
    //     · project(`:171-182`):从 git worktree 根**逐级向下走到 cwd**,每一级取
    //       `<dir>/.kimi-code/AGENTS.md`(`:82` 的 `dotKimiAgentsMdPath`)**加上**
    //       `<dir>/AGENTS.md` / `<dir>/agents.md` 的首个命中,全部拼接后按规范化路径去重。
    // ⚠️ 两条**登记不出来**的差异,别当成已覆盖:
    //     · `KIMI_CODE_HOME` 能整个挪走 global 那个品牌根,而这里的 path 是 home 相对的,跟不了;
    //       默认值 `~/.kimi-code` 才是这里登记的东西。
    //       (`~/.agents/` 那条读的是真 OS home,`KIMI_CODE_HOME` **挪不动**它 —— 两者不同源。)
    //     · project 那条是**逐级向下**的,这里只登记项目根一级;深目录里的那几份读不到。
    // ⚠️ `satisfies` 不是装饰,理由同 sessionBundle(zod 4 的 ZodType Input 是 unknown)。
    memory: {
      kind: 'files',
      entries: [
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.kimi-code/AGENTS.md' },
        { kind: 'file', scope: 'global', channel: 'agents-md', path: '.agents/AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: 'AGENTS.md' },
        { kind: 'file', scope: 'project', channel: 'agents-md', path: '.kimi-code/AGENTS.md' },
      ],
    } satisfies AgentMemoryDescriptor,
    /**
     * 终端腿的消息通道 —— **PTY keystroke**。Kimi 0.39.1 没有原生首句通道，owner 矩阵授权
     * 采用「预信任 + 逐字符 + CR」作为唯一可用的 TUI 首句路径。该授权只适用于无原生渠道的家族，
     * 不改变有原生渠道 provider 的降级红线。
     *
     * ⚠️ 逐字符写入**绕不开** kimi 的粘贴突发判定,恰恰相反,它正好触发它:间隔 ≤8ms 的
     *    ≥8 个字符 ⇒ 随后 120ms 内的 `\r` 被改判成换行而不是提交(2026-09-03 真机 4/26,
     *    失败形状一律是「字在框里、多一个空行、`Session:` 空」)。这里的 `submitDelayMs = 50`
     *    只是把 `\r` 与字符拆成两次写;真正让回车成为提交的是 `session-bundle.ts` 的
     *    `tuiEditorOverlay` —— 往咕咕自己那份 `tui.toml` 写 `disable_paste_burst = true`。
     *    ❌ 别把 `submitDelayMs` 调大当修复:判定用的是 kimi 处理键的时刻,不是写入时刻,
     *    启动期两者能差几百毫秒(0/550/1450/3000ms 补发回车实测 0/3)。
     *
     * Kimi 0.39.1 没有原生首句控制面（`-p` 是 headless、stdin/位置参数/serve/attach 均不构成
     * TUI 首句通道）。owner provenance 明确：对这类无原生渠道的 provider，TUI 首句允许使用
     * 预信任、逐字符写入并以 CR 提交的 PTY keystroke；有原生渠道的 provider 仍受
     * [[session-injection]]「禁止无条件回落 pty」红线约束。该能力描述与实现同 PR 落地。
     */
    prompt: {
      kind: 'keystroke',
      submitSequence: '\r',
      submitDelayMs: 50,
    },
    sessions: {
      kind: 'resumable',
      tuiResume: 'provider-id',
      // owner 实测「PTY 腿咕咕的提示词没注入」的根因(2026-08-28)。续跑两条 argv:有原生 id 走 `-S <id>`,没有就退到
      // `-C`(continue,按 cwd 找上一条)。而咕咕的身份自述在这条腿上是 `--agent-file`,与 `-S`/`-C` **互斥到拒绝启动**,
      // 所以只在「这次不是续跑」时才发。两者叠起来有一个洞:**第一次启动就崩掉**时(那次是 kimi 0.39.0 的首启迁移,
      // 两次物化只隔 3.5s,日志与 `~/.kimi-code/migration-errors.log` 对得上),kimi 还没上报过 id,重启却被记成续跑
      // ⇒ argv 发出 `-C` ⇒ 身份自述这条会话往后再也不发了,而 `-C` 找不到可续的会话,照样新建一条空的 —— 一次崩溃
      // 就把身份永久吞掉,全程没有一处报错。⇒ 没有原生 id 就不算续跑:不发 `-C`、发 `--agent-file`;有 id 才 `-S <id>`,
      // 那时 kimi 会从自己的会话记录(`agentProfileCatalog` 快照)还原绑定。咕咕记得住这个 id(实测
      // `sessions.provider_session_id` = `session_790d95c3-…`,与 `sessions.id` 不同),所以这条不会把 kimi 的续跑关掉。
      resumeNeedsProviderId: true,
    },
    trust: { kind: 'supported', channel: 'first-run-state' },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  // 声明了 `auth` 就**必须**配 `behavior.auth`(`session-shared/plugins/framework.ts` 直接抛,
  // 不是软性约定)。判据本体与它为什么在两个分支上说「不知道」,见 ./auth.ts。
  auth: { checkStatus: kimiAuthStatus },
  sessionBundle: { materialize: materializeKimiSessionBundle, platformModel },
  mcp: kimiMcpAdapter(),
  acp: createNativeAcpBehavior(() => ({
    args: ['acp'],
  })),
  prompt: {
    buildCommand: buildKimiCommand,
  },
  hooks: buildKimiHookConfig(),
  sessions: {
    validateProviderSessionId: undefined,
  },
  // 信任由 configRoot.firstRunState 在托管配置根里落,这里没有第二个写者。
  trust: { channel: 'first-run-state' },
});
