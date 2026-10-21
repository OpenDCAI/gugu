import { harnessPlatform } from './platform';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  GeneratedArtifact,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpProtocolServers,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';
import {
  join,
} from 'node:path';
import { sessionContextPrompt, sessionRunHome } from '../../helpers/session-bundle';

const VERSION = '1.1.19';
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Qoder CLI v${VERSION} ${unit} delivery has not been verified from its published source.`,
});
const unverifiedModel = unverified('model');
const unverifiedAutonomy = unverified('autonomy');
const unverifiedTuiPrompt = unverified('session-TUI system-prompt');
/**
 * 平台模型在 qoder 模型目录里的 `provider` 段与 key 前缀。
 *
 * ⚠️ 显式写 `key` 而不是靠厂商缺省的 `<provider>/<model>`：缺省是**它那边**的规则，
 *    咕咕这边还要用同一个字符串去填 `QODER_MODEL`，靠猜对方的缺省就是把两处真值分叉。
 */
export const QODER_PLATFORM_PROVIDER = 'gugu';
export function qoderPlatformModelKey(model: string): string {
  return `${QODER_PLATFORM_PROVIDER}/${model}`;
}
const QODER_SETTINGS_FILE = 'gugu-session-settings.json';
/**
 * 模型这一维**只有 session-TUI 腿兑现**。
 *
 * 那份 settings 文档要靠 argv 上的 `--settings <path>` 才被读到，而 ACP 腿的注入信封
 * （`apps/desktop/electron/session/main/core/acp/emdash-mcp-injector.ts` 的
 * `EmdashSessionCapabilityInjection`）只有 `mcpServers / spawnEnv / sessionMeta /
 * sessionPrompt / platformConfigured` —— **没有任何 argv 字段**。文档会被写到盘上
 * （artifacts 两条腿都落），但没有任何一句话能让 ACP 腿的 qoder 去读它。
 *
 * ⇒ 这里如实记 `unsupported-channel` 而不是 `unverified`：不是「还没验」，是这条腿上
 *   **没有载体**。❌ 别只发 `QODER_MODEL` 就算接通 —— 那样 key 指向一个不存在的自定义模型，
 *   qoder 会报 `Invalid model "…"`，等于把一次会话烧在一个必然失败的组合上。
 */
const acpModelHasNoCarrier: Degradation = {
  code: 'unsupported-channel',
  reason:
    'Qoder loads its BYOK model document from `--settings <path>`, and the session-ACP injection '
    + 'envelope carries no argv — that document has no carrier on this surface.',
};
const unverifiedExtension = unverified('extension');

export const qoderSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: harnessPlatform,
  // 只有终端腿拿得到平台模型(ACP 腿的注入契约 `wired: false`,信封没有 argv 载体)。令牌写在会话级
  // 0600 BYOK settings 文档里、经 `--settings <path>` 指过去,spawn 时读一次 ⇒ 到期按原形态重开。
  credentialLifecycle: {
    'tui': {
      delivery: 'process-config',
      originalProcessRefresh: 'unsupported',
      recovery: 'reopen',
      inferenceOwner: 'provider-process',
      reopenEntry: 'host-session-reload',
      sourceChangeSession: 'preserve',
    },
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': { identity: 'none', messageTransport: 'none' },
    'tui': { identity: 'addressable', messageTransport: 'local-session', inbound: 'none' },
  },
  units: {
    // MCP —— **两条腿答案不同**。
    //
    // ⚠️ 这一格 2026-08-28 之前是扁平声明(= 两条腿都 native),而 `acp-session` 的载体是
    //    `session/new` 的 `mcpServers`,**终端腿上根本没有这个东西**:PTY 那条路只取
    //    `argsAppend` / `env`。而通用物化的 `unitReport` 是按 descriptor 报数的,于是终端腿
    //    恒定报 `mcp: loaded` —— 一个字节都没送,报告却说送到了。
    //    owner 2026-08-28 在 kimi 上实测撞到(报告写 loaded、机器上连配置文件都不存在)。
    //    ⇒ 如实按腿声明。现在通用物化对这种声明直接抛,不会再有第二次。
    mcp: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        'tui': { kind: 'none', degraded: unverified('session-TUI MCP') },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    /**
     * 模型 —— 一份 **0600 settings 文档**（`modelConfigs.customModels`）+ 一个环境变量
     * （`QODER_MODEL`）。文档由 argv 上的 `--settings <path>` 指过去。
     *
     * 形状取自它自己发行的字节（@qoder-ai/qodercli@1.1.30）。厂商 settings schema 对这一项的
     * 描述逐字：「Each item requires `provider`, `apiKey` and `model`; optional … `baseURL`,
     * `key` (used with `-m`, defaults to "<provider>/<model>"), `displayName`, `format` (API
     * format/style metadata, allowed values: "openai" or "anthropic") … These are merged into
     * the model catalog and selectable via `qodercli -m <key>`.」
     *
     * 实测（隔离 HOME/XDG + `QODER_CONFIG_DIR` + 本地假 OpenAI 端点，**零推理、零配额、
     * 零厂商账号**）：`--settings` 收下合法的 inline/文件两种形态；**反例对照**给一段坏 JSON，
     * 它退回当路径并响亮报 `Settings file not found: <cwd>/<那段字符串>` ⇒ 这个探针判得了假。
     *
     * ⚠️ **`baseURL` 是大写 URL**，不是 `baseUrl`。写错不报错 —— 归一化器 `CiA(A.baseURL)`
     *    取不到就落到缺省空串，请求打去厂商默认端点。
     *
     * ⚠️ **缺必填字段是 fail-open**：只打一行
     *    `[settings-byok] Skipping modelConfigs.customModels[i]: missing required field(s): …`
     *    然后照常起会话、用用户自己的模型。⇒ 与 qwen/kimi 同一条纪律：这次注入不成立就
     *    **一个字段都别发**，❌ 别发半套。
     *
     * ⚠️ 令牌走**文档**不走 argv：argv 在进程表里人人可读。这与 claude 那条
     *    `--settings <path>`（而不是内联 JSON）是同一个判据。
     *
     * ⚠️ 用 `QODER_MODEL` 而不是 `-m`：它的选项回填器在**对应旗标缺席时**把 `QODER_MODEL` /
     *    `QODER_PERMISSION_MODE` 等六个变量填进同一个已解析选项对象 ⇒ 与旗标等价；而 env
     *    两条腿都到得了，argv 只有 session-TUI 腿收得到。
     *    ⇒ 反过来说：用户自己在 extraArgs 里写了 `-m`，他的旗标赢，咕咕这一格静默让位。
     *      这是厂商定的优先级，如实记在这里。
     */
    model: { kind: 'native', channel: 'process-config' },
    /**
     * 自治级别 —— `QODER_PERMISSION_MODE`（等价于 `--permission-mode`）。
     *
     * **实测拿到了它自己报的合法值全集**（隔离 HOME，给一个瞎编的档位）：
     *   `Invalid values:`
     *   `  Argument: permission-mode, Given: "bogus_mode", Choices: "default", "plan", "auto",`
     *   `  "bypass_permissions", "accept_edits", "dont_ask"`
     * 阳性对照：`--permission-mode plan` 被收下（走过 argv 校验，停在后面的登录闸）。
     *
     * ⚠️ **`--help` 只登了五个**（漏 `plan`）—— 照 `--help` 写就会漏掉规划档。以运行时报的
     *    这六个为准，那才是真正的判据。
     *
     * ⚠️ `plan` 这一档在厂商侧是 **fail-open**：用户 settings 里把 `general.plan.enabled`
     *    关掉之后，它只 warn 一句
     *    `Permission mode "plan" is disabled in your settings. Falling back to "default".`
     *    然后**降级成 default 照跑**。咕咕这一维只投递「完全访问 / 非完全访问」两态，
     *    不碰 `plan`，所以这条不影响本格；记下来是给下一个想接四档的人。
     */
    autonomy: { kind: 'native', channel: 'process-config' },
    // 身份自述 —— 走 ③（`session-context`）：同一段话以**用户级载体**进到首轮的输入里。
    //
    // ⚠️ **这一格 2026-08-27 之前写的是 `first-turn-hidden-context`，那是一条送不到的通道。**
    //    它的载体是 `materialization.prompt`，宿主把它落成 `session/new` 的
    //    `_meta.systemPrompt.append` —— 而那个键是**咕咕自己的约定**，不是 ACP 协议的字段；
    //    只有咕咕给 codex 写的那座 shim 和 claude 的适配器在读。本家跑的是**厂商原生**的
    //    ACP server（`createNativeAcpBehavior`），`_meta` 对它是个开放 record，收下即丢。
    //    同形的 copilot 实测过：`_meta.systemPrompt.append` 命中 **0/6**，换成它自己的通道
    //    6/6，阳性对照证明仪器看得见（见 impl/copilot/session-bundle.ts）。
    //    ⚠️ 那一版的声明是**裸的**——同一个文件里别的维度都有密实的一手出处，唯独这一格
    //    一句注释都没有。它从来没被测量过。
    //
    // ⇒ 改走 ③：`session/prompt` 是协议的**主通道**，每个 ACP agent 都必须读它。
    //    这不是降级（behavior `agent-context-injection`「②③ 只差载体」），身份仍是系统
    //    提示词，照样不展示给用户。
    // ⚠️ 换通道**必须**同时让物化器自报 `carrier: 'session-context'` —— 漏了会静默回落
    //    系统位，也就是回到那个黑洞。conformance 有judge 钉这一对必须一致。
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        // ⚠️ **终端腿从来没被量过。** 这一格此前是**扁平**声明(= 两条腿都认领),而同一个文件里
        //    物化器在终端腿上既不产出 prompt、报告也是 degraded —— **声明与它自己的报告互相
        //    矛盾**,只是从来没有判据问过这一对。2026-08-27 新加的「声明 session-context 的家
        //    必须自报同名载体」那条判据一跑就把四家一起抓了出来。
        //    ⇒ 如实记 unverified,❌ 不拿 ACP 腿那条顶上来充数
        //      (behavior `agent-config-boundary`:不借另一条腿的通道假装它有)。
        'tui': { kind: 'none', degraded: unverifiedTuiPrompt },
      },
    },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  /**
   * 前四条由 **ACP 腿**兑现:qoder 的 `acp` surface 走咕咕自己的 ACP 运行时
   * (impl/qoder/index.ts 的 `provider.acp = createNativeAcpBehavior(['--acp'])`),中间没有
   * 咕咕自建的桥,拿的是协议层的通用能力 —— 与 qoder 这一家的私有实现无关。
   * session-TUI 腿这四条一条都没有(那条腿只有 `stopSession`,是**停止**不是暂停),合并后取 ACP 腿这份。
   * 第五条 memory 与 surface 无关:它读的是磁盘上 qoder 自己会去读的那几个文件。
   */
  coexistence: {
    /**
     * 协议 cancel:`cancelTurn` → `cell.cancel()` → `agent.cancel({ sessionId })`
     * (session-runtime/src/acp-agents/session/cell.ts:287),turn 落到自己的 `cancelled` 结局
     * (session-core/src/acp/models/turns/turn.ts:22,45)。⚠️ 进程活着、会话还在 = 暂停,不是停止/移除。
     */
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /**
     * `session/update` 通知经 `buildAgentClient.sessionUpdate`
     * (session-runtime/src/acp-agents/agent-ports/agent-client.ts:51)进 cell,驱动
     * `AgentActivity active:true/false`(cell.ts:186,638)与 `TurnEnded`(cell.ts:421)
     * —— 咕咕观测得到「本轮在飞」。
     */
    observability: { kind: 'native', channel: 'acp-update' },
    /**
     * `session/request_permission` 落进 `pendingPermissions`(cell.ts:318),由人在会话界面
     * 选项后 `resolvePermission` 回填(apps/desktop/src/session/renderer/features/sessions/
     * acp/acp-chat-panel.tsx:377)—— 一条真通到人的路。
     */
    askUser: { kind: 'native', channel: 'permission-ask' },
    /** ACP `plan` 更新归一成结构化 `entries`(session-core/src/acp/reducer/normalized-event.ts:155),不是纯 markdown。 */
    todo: { kind: 'native', channel: 'acp-plan' },
    /**
     * 咕咕经 `AgentPluginHost.readMemoryFiles`(session-core/.../plugin-host.ts:270)读得到 qoder
     * 自己会去读的那几个文件 —— 具体登记在 `impl/qoder/index.ts` 的 `capabilities.memory`,
     * 通道 `agents-md`(AGENTS.md / AGENTS.local.md 是跨厂商约定,不是 qoder 的专名文件)。
     * 厂商出处:https://docs.qoder.com/en/cli/memory
     * ⚠️ 两处必须同通道。
     */
    memory: { kind: 'native', channel: 'agents-md' },
    /**
     * 读侧自省 —— 扫**用户自己那份** MCP 配置,不启引擎。
     *
     * ⚠️ 这一条**解掉了上一版明写的欠账**。上一版留欠的理由是「官方文档记了文件路径,但
     * **没有公布那份文件里的 JSON 键名**,而 `serversKey` 填错就是静默读空/写坏用户配置」——
     * 理由本身是对的,现在键名取到了,三处独立互证:
     *  · https://docs.qoder.com/cli/settings-reference.md 的 Top-Level Configurations 表原文
     *    「| `mcpServers` | object | `{}` | Yes | MCP server configuration. |」
     *  · https://docs.qoder.com/cli/settings.md 同名条目(「MCP server configurations
     *    (requires restart)」)
     *  · **实测**:拿 npm 上的 `@qoder-ai/qodercli@1.1.29` 起一个一次性 `QODER_CONFIG_DIR`,
     *    `qodercli mcp add testsrv -s user -- echo hi` 之后 `settings.json` 的内容是
     *    `{ "mcpServers": { "testsrv": { "command": "echo", "args": ["hi"] } } }` ——
     *    键名与逐服务器形状都与 `passthroughMcpAdapter` 一致。
     * 接线在 `impl/qoder/index.ts`:`capabilities.mcp` 为 supported + `behavior.mcp =
     * passthroughMcpAdapter('.qoder/settings.json')`,`readServers` 报出的是用户自己写的那些。
     *
     * ⚠️ 只扫用户级那一份,**故意不加** `${project}/.mcp.json` 与
     * `${project}/.qoder/settings.local.json`:MCP 适配器那条路的 `PluginFs` 根是
     * `os.homedir()`(`apps/desktop/electron/session/main/core/mcp/services/McpService.ts:42`
     * 的 `createPluginFs(os.homedir())`),把工作区相对路径塞进 `legacyReadPaths` 会去家目录下
     * 找一个永远不存在的文件 —— 静默读空,比缺一条难查。
     * ⚠️ `QODER_CONFIG_DIR` / `QODER_CLI_HOME` / `--config-dir` 能把 `~/.qoder` 挪走;挪走之后
     * 这条路读到空(= 与「用户没配过」表现一致),不会读错别人的文件。同 memory 那段的口径。
     */
    introspection: { kind: 'native', channel: 'config-scan' },
    // ❌ 不写 history:core 的 `transcriptSources/` 注册表当前只有 claude-code 与 codex 两份 spec。
    //    接通它 = 在那里加一份 spec 并登记进 TRANSCRIPT_SOURCE_IDS,不是在这里改一行声明。
    //    ⚠️ 路径这一波取到了官方出处,留给接的人:https://docs.qoder.com/cli/sessions.md 原文
    //    `~/.qoder/projects/<processed-project-path-name>/<session-id>.jsonl` 与同目录的
    //    `<session-id>/state.json`,根可由 `QODER_CONFIG_DIR` 改。
    //    ⚠️ `<processed-project-path-name>` 的具体变换**官方没公布** —— 那正是写 spec 时会踩的坑。
    // cron 落回基类 —— 这是「咕咕还没接」,不是「qoder 做不到」。
  },
} satisfies SessionBundleDescriptor;

function processConfig(bundle: SessionCapabilityBundle): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(bundle.mcpServers.map((server) => {
      if (server.transport === 'stdio') {
        assertSessionMcpStdioEnv(server, bundle, 'Qoder');
        return [server.name, sessionMcpStdioConfig(server)];
      }
      const credential = sessionMcpAuthorization(server, bundle.env, 'Qoder');
      return [server.name, {
        type: 'http',
        url: server.url,
        ...(credential ? { headers: { Authorization: credential } } : {}),
      }];
    })),
  });
}

function report(
  ctx: SessionMaterializationContext,
  promptLoaded: boolean,
  modelDelivered: boolean,
  autonomyDelivered: boolean
): SessionMaterialization['report'] {
  const loaded = { status: 'loaded' as const };
  return {
    adapterId: 'qoder',
    surface: ctx.surface,
    units: {
      mcp: loaded,
      env: loaded,
      model: modelDelivered
        ? loaded
        : {
            status: 'degraded',
            reason: ctx.surface === 'acp' ? acpModelHasNoCarrier : unverifiedModel,
          },
      autonomy: autonomyDelivered
        ? loaded
        : { status: 'degraded', reason: unverifiedAutonomy },
      promptBlocks: promptLoaded
        ? loaded
        : { status: 'degraded', reason: unverifiedTuiPrompt },
      packages: { status: 'degraded', reason: unverifiedExtension },
    },
    discoveredCommands: [],
  };
}

/**
 * 平台模型 → 一条 `modelConfigs.customModels` 条目。
 *
 * ⚠️ 与 qwen / kimi 同一条纪律：**这次注入不成立就返回 null**，一个字段都不发。
 *    半套字段在这一家是 fail-open（只 warn 一行然后用用户自己的模型），
 *    比起不起会话更难查 —— 界面写着咕咕的模型、实际花的是用户自己的额度。
 */
function platformModelEntry(bundle: SessionCapabilityBundle): Record<string, unknown> | null {
  const model = bundle.model;
  if (!model) return null;
  if (model.dialect !== 'qoder-byok-settings') {
    throw new Error(`Qoder session adapter cannot materialize model dialect '${model.dialect}'`);
  }
  const platform = model.platformProvider;
  if (!platform) return null;
  const selected = model.model?.trim();
  if (!selected) return null;
  return {
    key: qoderPlatformModelKey(selected),
    displayName: selected,
    provider: QODER_PLATFORM_PROVIDER,
    model: selected,
    apiKey: platform.apiKey,
    // ⚠️ 大写 URL。写成 `baseUrl` 不报错，落到缺省空串、请求打去厂商默认端点。
    baseURL: platform.baseUrl,
    // 允许值只有 "openai" / "anthropic"（厂商 schema 原文）。咕咕网关是 OpenAI 兼容面。
    format: 'openai',
    ...(model.contextWindow && model.contextWindow > 0
      ? { maxInputTokens: model.contextWindow }
      : {}),
  };
}

/** 完全访问 ↔ 其余。❌ 不摆 `plan`：咕咕这一维只有两态，见 units.autonomy 的抬头。 */
function permissionMode(bundle: SessionCapabilityBundle): string | null {
  if (!bundle.autonomy) return null;
  return bundle.autonomy.mode === 'full-access' ? 'bypass_permissions' : 'default';
}

export function materializeQoderSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!qoderSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Qoder session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // 自治级别两条腿都到得了：`QODER_PERMISSION_MODE` 走 spawnEnv，而 ACP 注入信封是有
  // `spawnEnv` 这一格的（缺的只是 argv）。
  const mode = permissionMode(bundle);
  if (mode) env.QODER_PERMISSION_MODE = mode;

  if (ctx.surface === 'acp') {
    const mcpServers = sessionMcpProtocolServers(bundle, 'Qoder');
    const prompt = sessionContextPrompt(bundle.promptBlocks);
    for (const server of bundle.mcpServers) {
      if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
    }
    // ⚠️ 这条腿上**不发** `QODER_MODEL`：那份定义模型的 settings 文档没有载体（见
    //    `acpModelHasNoCarrier`），只发 key 会让 qoder 报 `Invalid model "…"`。
    return {
      argsAppend: [],
      env,
      acp: { mcpServers },
      ...(prompt ? { prompt } : {}),
      configMerges: [],
      artifacts: [],
      report: report(ctx, Boolean(prompt), false, Boolean(mode)),
    };
  }

  env.QODER_MCP_CONFIG = processConfig(bundle);
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
  }

  const entry = platformModelEntry(bundle);
  const argsAppend: string[] = [];
  const artifacts: GeneratedArtifact[] = [];
  if (entry) {
    const settingsPath = join(sessionRunHome(bundle, 'Qoder', 'qoder-capability-runs'), QODER_SETTINGS_FILE);
    artifacts.push({
      path: settingsPath,
      content: `${JSON.stringify({ modelConfigs: { customModels: [entry] } }, null, 2)}\n`,
      // ⚠️ 0600 不是装饰：这份文档里有这次会话的中转令牌。
      mode: 0o600 as const,
    });
    // ⚠️ 传**路径**不传内联 JSON。它两种都吃，但内联等于把令牌写进进程表。
    argsAppend.push('--settings', settingsPath);
    env.QODER_MODEL = String(entry.key);
  }
  return {
    argsAppend,
    env,
    configMerges: [],
    artifacts,
    report: report(ctx, false, Boolean(entry), Boolean(mode)),
  };
}
