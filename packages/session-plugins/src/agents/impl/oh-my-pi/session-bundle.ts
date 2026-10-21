import { PLATFORM_NOT_WIRED } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import { materializeAcpSessionBundle } from '../../helpers/session-bundle';

export const OH_MY_PI_ACP_VERSION = '17.2.13';
export const OH_MY_PI_ACP_SOURCE =
  '@oh-my-pi/pi-coding-agent@17.2.13 src/modes/acp/acp-agent.ts:552-555 passes params.mcpServers to createNewSessionRecord; lines 1056-1064 and 1135-1147 carry it into awaited configureMcpServers before session registration; lines 2427-2489 map servers, await connectServers, throw on connection errors, and refresh the exact session tool set. dist/cli.js contains the same published path.';

const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Oh My Pi ${OH_MY_PI_ACP_VERSION} ${unit} delivery has not been verified from its published agent bytes.`,
});

const unverifiedSessionTuiMcp: Degradation = {
  code: 'unverified',
  reason:
    `Oh My Pi ${OH_MY_PI_ACP_VERSION} consumes session/new.mcpServers in ACP mode; ` +
    'the session-TUI surface does not consume that ACP request field.',
};

const unverifiedSessionTuiPrompt: Degradation = {
  code: 'unverified',
  reason:
    `Oh My Pi ${OH_MY_PI_ACP_VERSION} session-TUI prompt delivery has not been verified; ` +
    'first-turn hidden context belongs to the session-ACP runtime surface.',
};

export const ohMyPiSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  shellEnv: {
    passThrough: [
      'OMP_AUTH_BROKER_SNAPSHOT_CACHE',
      'OMP_AUTH_BROKER_SNAPSHOT_TTL_MS',
      'OMP_AUTH_BROKER_URL',
      'PI_CODING_AGENT_DIR',
    ],
  },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': { identity: 'none', messageTransport: 'none' },
    'tui': { identity: 'addressable', messageTransport: 'local-session' },
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
    env: { kind: 'none', degraded: unverified('environment') },
    model: { kind: 'none', degraded: unverified('model') },
    autonomy: { kind: 'none', degraded: unverified('autonomy') },
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
        'tui': { kind: 'none', degraded: unverifiedSessionTuiPrompt },
      },
    },
  },
  extension: { kind: 'none', degraded: unverified('extension') },
  coexistence: {
    // 这四条都由 ACP 腿(`surfaces` 含 'acp',provider.acp = createNativeAcpBehavior(`omp acp`))
    // 提供,与厂商无关 —— 咕咕对任何走 ACP 的家都已接通:
    //  · cancel:SessionMachine 的 'cancelling' 相 → cell.ts 打 agent.cancel({sessionId}),
    //    进程留着、会话还在,是**暂停**不是停止。
    //  · plan:decode 出 { kind:'plan', entries } 后由 reducer/item-fold 折进 transcript。
    //  · observability:session-runtime/src/acp-agents/machine/machine.ts:410 projectSessionState
    //    产出 isGenerating / canCancel / lifecycle —— 咕咕的会话状态词汇里读得到「本轮在飞」。
    //  · askUser:session-runtime/src/acp-agents/session/cell.ts:318 requestPermission 生成带 options
    //    的待决请求 → session-chat-ui/src/state/chat-state.ts:364 进到 UI → 用户点选后 cell.ts:299
    //    resolvePermission 结算。⚠️ 只算**授权型**;澄清型(mcp-elicitation / native-tool)咕咕
    //    没通,❌ 不许声明。
    //    另有 event-stream 通道:plugin-file.ts:53,60,64 的 session_stop / agent_end /
    //    session_shutdown 把 stop POST 到 GUGU_HOOK_PORT(消费方 宿主 agent-hook-service 的 deriveAgentStatus);
    //    单维只能记一个通道,这里取信号更全的 acp-update —— 它报「本轮在飞」,
    //    hook 链主要报「转空闲」。
    pause: { kind: 'native', channel: 'protocol-cancel' },
    observability: { kind: 'native', channel: 'acp-update' },
    askUser: { kind: 'native', channel: 'permission-ask' },
    todo: { kind: 'native', channel: 'acp-plan' },
    // 记忆文件读得到:`impl/oh-my-pi/index.ts` 的 capabilities.memory 登记了 omp 的 context files
    // (出处见那一段),宿主经 AgentPluginHost.readMemoryFiles(plugin-host.ts:270)按登记逐条读回。
    // 那条路读的是磁盘、不需要会话,与 ACP 腿无关。
    // ⚠️ channel 必须与 capabilities.memory 登记的通道对得上;那边同时登记了 `vendor-file`
    //    (RULES.md),一维只能记一个,取覆盖面更大的 agents-md。只要求声明的 channel 在登记
    //    集合里,双通道不冲突。
    memory: { kind: 'native', channel: 'agents-md' },
    // ⚠️ introspection 不算:oh-my-pi 没有 mcp 行为(units.mcp 走 ACP 的 session/new.mcpServers,
    //    那是**推**进去,不是可扫的用户配置文件);它的 plugins 是 createFileDropPlugin,
    //    只写/删/探**咕咕自己那一个** `.omp/extensions/gugu-hook.ts`,从不枚举用户自己的
    //    extension。其余三维落回基类,历史读回也只接了 claude-code 与 codex(transcriptInventory.ts)。
  },
} satisfies SessionBundleDescriptor;

function materializeSessionTui(
  ctx: SessionMaterializationContext,
  _bundle: SessionCapabilityBundle
): SessionMaterialization {
  const degraded = (reason: Degradation) => ({ status: 'degraded' as const, reason });

  return {
    argsAppend: [],
    env: {},
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'oh-my-pi',
      surface: ctx.surface,
      units: {
        mcp: degraded(unverifiedSessionTuiMcp),
        env: degraded(ohMyPiSessionBundleDescriptor.units.env.degraded),
        model: degraded(ohMyPiSessionBundleDescriptor.units.model.degraded),
        autonomy: degraded(ohMyPiSessionBundleDescriptor.units.autonomy.degraded),
        promptBlocks: degraded(unverifiedSessionTuiPrompt),
        packages: degraded(ohMyPiSessionBundleDescriptor.extension.degraded),
      },
      discoveredCommands: [],
    },
  };
}

const promptKeys = ['platform', 'identity'] as const;

function materializeSessionAcp(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const authorizationEnv = new Set(
    bundle.mcpServers.flatMap((server) =>
      server.transport !== 'stdio' && server.authorizationEnv ? [server.authorizationEnv] : []
    )
  );
  const authOnlyBundle = {
    ...bundle,
    env: Object.fromEntries(
      Object.entries(bundle.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && authorizationEnv.has(entry[0])
      )
    ),
  };
  const result = materializeAcpSessionBundle(
    'oh-my-pi',
    ohMyPiSessionBundleDescriptor,
    ctx,
    authOnlyBundle
  );
  const delivered = promptKeys.filter((key) => Boolean(bundle.promptBlocks[key]));
  const value = delivered.map((key) => bundle.promptBlocks[key]).join('');

  return {
    ...result,
    // ⚠️ `carrier` 必须显式写出来：缺席 = 静默回落系统位（`_meta.systemPrompt.append`），
    //    而本家跑的是厂商原生 ACP server，那个键对它是黑洞。见 units.promptBlocks 抬头。
    ...(value ? { prompt: { value, delivered, carrier: 'session-context' as const } } : {}),
    report: {
      ...result.report,
      units: {
        ...result.report.units,
        promptBlocks: value
          ? { status: 'loaded' }
          : { status: 'degraded', reason: unverified('empty prompt') },
      },
    },
  };
}

export function materializeOhMyPiSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (ctx.surface === 'tui') return materializeSessionTui(ctx, bundle);
  return materializeSessionAcp(ctx, bundle);
}
