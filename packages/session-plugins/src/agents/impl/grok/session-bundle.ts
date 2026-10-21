import { PLATFORM_NOT_WIRED } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  sessionMcpProtocolServers,
} from '../../helpers/session-mcp';
import { sessionContextPrompt } from '../../helpers/session-bundle';

// 探针实测的版本 —— P1/P2/P3 全部在 `@xai-official/grok` 1.0.13 上取证(#4658)。
// 声明里凡带「实测」的读数都指这个版本;换版本要重跑探针再改这里。
const VERSION = '1.0.13';
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Grok CLI v${VERSION} ${unit} delivery has not been verified from its published source.`,
});
// 终端腿(session-TUI)四维一条都没量过 —— 与 qwen 同一笔账:ACP 腿有一手探针,终端腿没有,
// ❌ 不拿 ACP 腿那条顶上来充数。
const unverifiedTuiMcp = unverified('session-TUI MCP');
const unverifiedTuiModel = unverified('session-TUI model');
const unverifiedTuiAutonomy = unverified('session-TUI autonomy');
const unverifiedTuiPrompt = unverified('session-TUI system-prompt');
const unverifiedExtension = unverified('extension');

export const grokSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  shellEnv: {
    passThrough: [
      'GROK_CODE_XAI_API_KEY',
      'GROK_DEPLOYMENT_KEY',
      'GROK_HOME',
      'GROK_POOL_IDLE_TIMEOUT_SECS',
      'GROK_PROXY_URL',
      'GROK_SANDBOX',
    ],
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    // 厂商原生 ACP 已有可寻址 leader IPC；普通消息经 router 投递，busy 时只在下一轮可见
    // (idle-only)，不能把这条结构能力夸成 next-tool-call。
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'idle-only',
        evidence: 'https://github.com/nmhjklnm/gugu/issues/4716#issuecomment-5498265083',
        deviations: 'Grok 1.0.13 leader IPC accepts a busy prompt only after the active turn ends; the host attempts direct admission and surfaces queued-only results as failure.',
      },
    },
    // ⚠️ 终端腿也置 none/none。此前是 `addressable/local-session`,而这条腿的物化从来没被量过
    //    (units 四维全 unverified)。留着 local-session 的后果是 A 读数里那条:聊天页新建 grok
    //    发送后,createSession 成功 → 首句 sendMessage 成功路径走完(正文清空)→ 物化在 hydration 阶段
    //    throw → 界面零错误、draft 永不 hide(#4602 comment 5488865132 记的静默假死)。
    //    置 none 后 `firstTurnTransportOf` 给出 `'none'`,`use-create-session-callback` 的
    //    `messageTransportError` 当场亮红、建按钮禁用并写出「Provider 'grok' has no … message
    //    transport」—— 把静默假死换成一句响亮的诚实错误。这是**如实的延迟**,不是能力回退:
    //    终端腿的首句通道要等 #4653 链把语义定下来再开(边界 ②)。
    //    `reason` 把这句「为什么」原样接到那条红字后面(#4658 ②):裸英文,与邻行文风一致。
    'tui': {
      identity: 'none',
      messageTransport: 'none',
      reason:
        `Grok CLI v${VERSION} terminal-session first-turn delivery has not been verified from its `
        + `published source; this leg is deferred pending the session-TUI first-turn work (#4653).`,
    },
  },
  units: {
    // MCP —— ACP 腿走 `session/new` 的 mcpServers(P2 实测:宿主形状的 http 条目 grok 收得下,
    // `Authorization` header 逐字送达假 MCP server,工具被真的调用;阴性对照 driver 不带 --mcp-url
    // 时 server 日志零新增 ⇒ 判得了假)。终端腿没量过。
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        'tui': { kind: 'none', degraded: unverifiedTuiMcp },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    // 模型 —— ACP 腿纯进程环境,三个 canonical 的 xAI 变量,一次都不落配置文件。
    //
    // 出处(P1 实测,`@xai-official/grok` 1.0.13,隔离 GROK_HOME + 本地假 OpenAI 端点,
    // 零 ~/.grok 配置、零真实推理):
    //  · case A 三件套 `GROK_MODELS_BASE_URL` + `GROK_DEFAULT_MODEL` + `XAI_API_KEY` 全给
    //    → 请求打到假端点,`Authorization: Bearer <给的 key>`、body `model` = 给的 id;
    //  · 变异对照(换 key、换 model id)两个读数都跟着变 ⇒ 探针判得了假。
    // ⚠️ 通道是 `process-config` 而不是 `child-process`:与下面 `env` 那条不是一回事 ——
    //    `env` 记「把给进来的环境变量原样传下去」,这条记「咕咕按选中的模型**算出**一组变量再注」。
    // 终端腿没量过。
    model: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'process-config' },
        'tui': { kind: 'none', degraded: unverifiedTuiModel },
      },
    },
    // 自治级别 —— ACP 腿走 `process-config`(咕咕算出 `GROK_DEFAULT_PERMISSION_MODE` 注进进程环境)。
    //
    // ⚠️ **grok 1.0.13 的 ACP server 在结构上恒为完全访问**(P3 实测,决定性读数 P3f):
    //    它从不发 `session/request_permission`,拿真原生工具 `run_terminal_command` 试,
    //    always-approve 与不设该变量两种情形**行为逐字相同** —— 工具照样直接执行。
    //    `GROK_DEFAULT_PERMISSION_MODE` 是厂商文档里的旋钮(二进制字符串里也在),但对 ACP 的
    //    可观测行为没有落差。⇒ 所以这一维的诚实只有一种写法:
    //    · `full-access`       → 注 `GROK_DEFAULT_PERMISSION_MODE=always-approve`,与 grok 的
    //      实际行为(恒执行)一致 —— 咕咕要完全访问,grok 就给完全访问,声明与事实对得上。
    //    · `approval-required` → grok **做不到**(P3f),物化器 fail loud,❌ 绝不伪装成
    //      「已按需询问」。伪装的代价是用户以为要被问、实际满权限静默执行。见下面 `applyAutonomyEnv`。
    // ⚠️ ❌ 不走 argv:`buildAcpSpawn`(plugin-host.ts)只从 `provider.behavior.buildSpawn` 造 args,
    //    ACP 注入信封没有 extraArgs 通道,argsAppend 在这条腿是**静默 no-op**(qwen 的 ACP 腿
    //    返回 argsAppend 就是死代码)。所以 grok 的自治只能骑 env。
    // 终端腿另有一路:裸 `grok` 的 `--always-approve` 由 `prompt.buildCommand` 落在 argv 上,
    // 与这一格无关,所以终端腿这一维如实记 unverified。
    autonomy: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'process-config' },
        'tui': { kind: 'none', degraded: unverifiedTuiAutonomy },
      },
    },
    // 身份自述 —— ACP 腿走 ③(`session-context`):会话级系统提示词以用户级载体进首轮输入。
    //
    // grok 实测(P1/P2/P3 各波)都逐字服从首轮 prompt 里的指令(回 OK / 调指定工具 / 跑指定命令)
    // ⇒ 那本身就是「首轮 prompt 到得了 grok」的阳性对照。走 ③ 不是降级,身份仍是系统提示词、
    // 照样不展示给用户;换的只是载体。
    // ⚠️ 换通道**必须**同时让物化器自报 `carrier: 'session-context'`(见 `renderedPrompt`)——
    //    漏了会静默回落系统位 `_meta.systemPrompt.append`,而本家跑厂商原生 ACP server,那个键
    //    对它是黑洞(与 qwen/copilot 同形)。conformance 有 judge 钉这一对必须一致。
    // 终端腿没量过。
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        'tui': { kind: 'none', degraded: unverifiedTuiPrompt },
      },
    },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  coexistence: {
    // 声明的 `acp` surface 经 `createNativeAcpBehavior` 接上宿主共用的 ACP 栈:
    // - 打断走协议 cancel,落在 turn 状态机的 cancelled outcome 上(session-core/src/acp/models/turns/turn.ts)
    // - plan 由共用 reducer 解成结构化 entries(session-core/src/acp/reducer/normalized-event.ts)
    // - observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState 产出
    //   isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    // - askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options 的
    //   待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //   resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕没通,
    //   ❌ 不许声明。
    //   ⚠️ **实测提醒**:P3 证明 grok 1.0.13 的 ACP server 从不主动发 `session/request_permission`
    //   (它结构上恒执行)。这一格记的是**咕咕这条通道通不通**(cell 收到请求能不能递到人并回填),
    //   不是「grok 一定会发请求」——通道是通的,发不发由引擎定。两件事别混。
    //   终端腿**没有** event-stream 通道:交互 TUI 没有会话级 hooks 通道,hooks 声明 none(#6195,见 index.ts)。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // 下面这条读的是**用户自己的** `~/.grok/config.toml` `[mcp_servers]`:`grokMcpAdapter().readServers`
    // 把整张表原样读出来交给 McpService.loadAll(),里头咕咕没写过的条目照样出现在清单里。
    // ⚠️ 与 units.mcp 无关 —— 那格记的是「咕咕往会话里推 MCP」,这格记的是「咕咕扫得到用户装了什么」。
    introspection: { kind: 'native', channel: 'config-scan' },
    // 记忆文件:登记见 index.ts 的 `grokMemory`。⚠️ 与上面那格无关 —— introspection 读的是
    // `~/.grok/config.toml` 里装了什么(MCP/插件),这一格读的是引擎每轮都要吃进去的规则正文。
    memory: { kind: 'native', channel: 'agents-md' },
  },
} satisfies SessionBundleDescriptor;

/**
 * 把选中的模型落成 grok 认的那三个环境变量(P1 实测的 xAI 通道)。**只在 ACP 腿调**。
 *
 * ⚠️ 与 qwen 同一条纪律:这次注入不成立就**一个键都别发**。非平台会话(BYOK / 用户自己的 key)
 *    `platformProvider` 缺席,这里 early-return —— ❌ 别发半套,那会把用户自己选的端点顶掉。
 */
function applyModelEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  const model = bundle.model;
  if (!model) return;
  if (model.dialect !== 'grok-xai-env') {
    throw new Error(`Grok session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return;
  const selected = model.model?.trim();
  if (!selected) return;
  env.GROK_MODELS_BASE_URL = platform.baseUrl;
  env.GROK_DEFAULT_MODEL = selected;
  env.XAI_API_KEY = platform.apiKey;
}

/**
 * 把咕咕的自治档位落成 grok 的进程环境变量。**只在 ACP 腿调**。
 *
 * 见 units.autonomy 抬头:grok 1.0.13 的 ACP server 结构上恒为完全访问(P3f 决定性读数)。
 *  · `full-access`       → `GROK_DEFAULT_PERMISSION_MODE=always-approve`,与 grok 实际行为一致。
 *  · `approval-required` → grok 做不到(它从不发 `session/request_permission`)⇒ **fail loud**,
 *    ❌ 绝不静默地放一个满权限会话去冒充「已按需询问」。
 */
function applyAutonomyEnv(bundle: SessionCapabilityBundle, env: Record<string, string>): void {
  if (!bundle.autonomy) return;
  if (bundle.autonomy.mode === 'full-access') {
    env.GROK_DEFAULT_PERMISSION_MODE = 'always-approve';
    return;
  }
  throw new Error(
    "Grok CLI 1.0.13 cannot honor 'approval-required': its ACP server never raises "
      + 'session/request_permission and executes tools regardless (probe P3f, #4658). Refusing to '
      + 'materialize a session that would silently run with full access.'
  );
}

type UnitReport = { status: 'loaded' } | { status: 'degraded'; reason: Degradation };

function report(
  ctx: SessionMaterializationContext,
  units: {
    mcp: UnitReport;
    model: UnitReport;
    autonomy: UnitReport;
    promptBlocks: UnitReport;
  }
): SessionMaterialization['report'] {
  return {
    adapterId: 'grok',
    surface: ctx.surface,
    units: {
      mcp: units.mcp,
      env: { status: 'loaded' },
      model: units.model,
      autonomy: units.autonomy,
      promptBlocks: units.promptBlocks,
      packages: { status: 'degraded', reason: unverifiedExtension },
    },
    discoveredCommands: [],
  };
}

export function materializeGrokSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!grokSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Grok session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  if (ctx.surface === 'acp') {
    const mcpServers = sessionMcpProtocolServers(bundle, 'Grok');
    const prompt = sessionContextPrompt(bundle.promptBlocks);
    // 凭据不进物化产物 —— MCP 的 Authorization 由宿主按 server 名重新解析,授权值不落进被持久化的信封。
    for (const server of bundle.mcpServers) {
      if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
      if (server.transport === 'stdio') {
        for (const ref of Object.values(server.env ?? {})) delete env[ref];
      }
    }
    applyModelEnv(bundle, env);
    applyAutonomyEnv(bundle, env);
    return {
      // ❌ 不发 argv 自治:ACP 注入信封没有 extraArgs 通道,`buildAcpSpawn` 会丢掉它(见 units.autonomy)。
      argsAppend: [],
      env,
      acp: { mcpServers },
      ...(prompt ? { prompt } : {}),
      configMerges: [],
      artifacts: [],
      report: report(ctx, {
        mcp: { status: 'loaded' },
        model: bundle.model
          ? { status: 'loaded' }
          : { status: 'degraded', reason: unverified('model (none declared)') },
        autonomy: bundle.autonomy
          ? { status: 'loaded' }
          : { status: 'degraded', reason: unverified('autonomy (none declared)') },
        promptBlocks: prompt
          ? { status: 'loaded' }
          : { status: 'degraded', reason: unverified('system-prompt (none declared)') },
      }),
    };
  }

  // 终端腿 —— descriptor-wide 路由:一旦 ACP units 转 native,`declaresProviderMaterializedDelivery`
  // 为真,会话页 TUI(BYOK)创建也会路由到这个物化器。这条腿四维都没量过(units 全 unverified),
  // 唯一 native 的通道是 flat 的 env(child-process)。⇒ 只做 env 原样透传,如实报四维 degraded,
  // ❌ 不发 acp / prompt / taskTuiMcpServers / argv —— 那会替一条没量过的腿吹牛。
  // (平台模型的 TUI grok 走不到这里:它在宿主 `requireInjectionContract` 处就 fail loud,
  //  因为 engine-injection-contract 没有 grok 的 'tui' 行。)
  return {
    argsAppend: [],
    env,
    configMerges: [],
    artifacts: [],
    report: report(ctx, {
      mcp: { status: 'degraded', reason: unverifiedTuiMcp },
      model: { status: 'degraded', reason: unverifiedTuiModel },
      autonomy: { status: 'degraded', reason: unverifiedTuiAutonomy },
      promptBlocks: { status: 'degraded', reason: unverifiedTuiPrompt },
    }),
  };
}
