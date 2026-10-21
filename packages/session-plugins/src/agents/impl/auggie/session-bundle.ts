import { PLATFORM_NOT_WIRED } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpProtocolServers,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';
import { sessionContextPrompt } from '../../helpers/session-bundle';

const VERSION = '0.35.0';

const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Auggie v${VERSION} ${unit} delivery has not been verified from its published source.`,
});

const unverifiedModel = unverified('model');
const unverifiedAutonomy = unverified('autonomy');
const unverifiedTuiPrompt = unverified('session-TUI system-prompt');
const unverifiedExtension = unverified('extension');

export const auggieSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  shellEnv: { passThrough: ['AUGMENT_SESSION_AUTH'] },
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
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'none', degraded: unverifiedModel },
    autonomy: { kind: 'none', degraded: unverifiedAutonomy },
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
        'tui': { kind: 'none', degraded: unverified('session-TUI system-prompt') },
      },
    },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  /**
   * session-TUI 腿的中断键 —— **单按 Esc**。官方快捷键表原文
   * (https://docs.augmentcode.com/cli/interactive.md,取证 2026-08-24):
   * 「| `Escape` | Interrupt the active agent |」。
   *
   * ⚠️ ❌ 不许写成 presses: 2:**同一张表**的下一行是
   * 「| `Escape` + `Escape` | Clear the input box |」—— 双按是清输入框,填成双按等于顺手替用户
   * 删掉他还没发出去的话。
   *
   * ⚠️ ❌ 不许写成 Ctrl-C。那张表里 Ctrl-C 占了两行:「Interrupt the active agent」与
   * 「Press twice to exit」—— 同一个键叠了中断与退出两级,写 pty 的一侧数不清这是第几下。
   *
   * ⚠️ 这条**不改** `coexistence.pause`。auggie 是双腿家(`acp` + `tui`),pause 记的是
   * ACP 腿那条更强的 `protocol-cancel`;中断键只由本字段记录,供
   * `ptyController.interrupt` 在 TUI 会话上使用。判据见 `tuiInterruptSurfaceRequirement`。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'https://docs.augmentcode.com/cli/interactive.md 快捷键表「| `Escape` | Interrupt the active'
      + ' agent |」(同表下一行 `Escape`+`Escape` = Clear the input box);取证 2026-08-24',
  },
  /**
   * 下面五条的分工:pause / observability / askUser / todo 由 **ACP 腿**兑现 —— auggie 的
   * `acp` surface 走咕咕自己的 ACP 运行时(`createNativeAcpBehavior` + `auggie --acp`)。
   * introspection 也走 ACP 腿但依据不同(见那一条)。memory 与腿无关,是磁盘上的文件。
   */
  coexistence: {
    /** 协议 cancel:会话机有 `cancelling` 相位、turn 有 `cancelled` 结局(非「停止」「移除」)。 */
    pause: { kind: 'native', channel: 'protocol-cancel' },
    /** `session/update` 驱动 `lifecycle: 'working'` / `isGenerating` —— 咕咕观测得到「本轮在飞」。 */
    observability: { kind: 'native', channel: 'acp-update' },
    /** `session/request_permission` 落进 `pendingPermissions`,由人在会话界面选项后 `resolvePermission` 回填。 */
    askUser: { kind: 'native', channel: 'permission-ask' },
    /**
     * ACP `plan` 更新归一成结构化 `entries`,不是纯 markdown。
     *
     * ⚠️ 这一条曾经只是「含 acp 就该有」的横切外推,现在有一手出处了 —— 而且它推翻了一个
     * 看上去相反的读数:#3889 给 auggie 的 todo 证据串是「PlanMode非结构化」。那句话说的是
     * **Plan Mode**(把方案写成 markdown 存进 `~/.augment/plans/`),那确实不结构化;
     * 但走 ACP 出去的 plan 是**另一件事** —— 官方分发的 `@augmentcode/auggie@0.36.0` 的
     * `package/augment.mjs` 里,`onToolCallResult` 有一处
     * `n.plan && o.planEntries && this.conn.sessionUpdate({ sessionId, update: { sessionUpdate:
     * "plan", entries: o.planEntries } })`,entries 是 `{content, priority, status}` 的规范
     * ACP PlanEntry,由 Task Manager 的任务树(`add_tasks`/`update_tasks`/`reorganize_tasklist`)
     * 折出来。两者名字撞车、形态相反,❌ 别拿证据串那句去撤这条声明。
     */
    todo: { kind: 'native', channel: 'acp-plan' },
    /**
     * 读侧自省 —— 走**运行中的引擎**,不是扫配置文件。
     *
     * 咕咕这一侧的通路是通用装配、不分家:`available_commands_update` 这条 session/update 经
     * `session-core/src/acp/reducer/reducer.ts:511` 写进 `config.availableCommands`,再由
     * `apps/desktop/src/session/renderer/features/sessions/acp/acp-chat-store.ts:196` 的
     * `get commands()` 摆进 composer 的命令列表。
     *
     * auggie 这一侧确实发:同一份 `augment.mjs` 里
     * `await this.conn.sessionUpdate({ sessionId: this.id, update: { sessionUpdate:
     * "available_commands_update", availableCommands: r } })`,紧跟着
     * `this.logger.info(\`Advertised ${r.length} slash commands to client\`)`。
     *
     * ⚠️ 报出来的正是**用户自己的**东西 —— `r` 来自 `this.discoveredCommands`,即
     * `.augment/commands/` 那些命令文件、插件命令与 skills,不是咕咕注进去的任何东西。
     * 这正是本维「❌ 读咕咕注进去的不算」那条限定要的形状。
     *
     * ⚠️ 已知不完整,如实记在这里:(a) 一条都没发现时它**整条不发**
     * (`if (this.discoveredCommands.length === 0) { … return }`);(b) 内建斜杠命令
     * (`/plan` `/task` …)不在这张表里。所以这是「报得出用户自己那部分」,不是全量 dump。
     * ❌ 不许因此改成 `config-scan`:auggie 的规则/命令没有一份咕咕扫得动的单一配置文件。
     */
    introspection: { kind: 'native', channel: 'running-engine' },
    /**
     * 记忆文件在 `impl/auggie/index.ts` 的 `capabilities.memory` 登记,宿主 `readMemoryFiles`
     * 按声明读得到。channel 取 `vendor-file`:global 侧**只有** `.augment/rules`(auggie 没有
     * 全局 AGENTS.md),两个作用域都覆盖得到的只有它这一条。
     */
    memory: { kind: 'native', channel: 'vendor-file' },
    // 其余两维(history / cron)落回 BASE_SESSION_COEXISTENCE:
    //  · cron 整列缺主干(cron 这一维 auggie 厂商侧本来就是「无」);
    //  · history:会话存成 `~/.augment/sessions/<sessionId>.json`(**单个 JSON,不是 jsonl**,
    //    且 `view-session` 明写本地是缓存、服务端才是真源),而 core 的
    //    `TranscriptStorageChannel` 今天只有 `'jsonl'` 一种。
  },
} satisfies SessionBundleDescriptor;

function definedEnv(bundle: SessionCapabilityBundle): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function tuiArgs(bundle: SessionCapabilityBundle): string[] {
  return bundle.mcpServers.flatMap((server) => {
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, 'Auggie');
      return ['--mcp-config', JSON.stringify({ name: server.name, ...sessionMcpStdioConfig(server) })];
    }
    sessionMcpAuthorization(server, bundle.env, 'Auggie');
    return [
      '--mcp-config',
      JSON.stringify({
        type: 'http',
        name: server.name,
        url: server.url,
        ...(server.authorizationEnv
          ? { headers: { Authorization: `\${${server.authorizationEnv}}` } }
          : {}),
      }),
    ];
  });
}

function report(
  ctx: SessionMaterializationContext,
  promptLoaded: boolean
): SessionMaterialization['report'] {
  const loaded = { status: 'loaded' as const };
  return {
    adapterId: 'auggie',
    surface: ctx.surface,
    units: {
      mcp: loaded,
      env: loaded,
      model: { status: 'degraded', reason: unverifiedModel },
      autonomy: { status: 'degraded', reason: unverifiedAutonomy },
      promptBlocks: promptLoaded
        ? loaded
        : { status: 'degraded', reason: unverifiedTuiPrompt },
      packages: { status: 'degraded', reason: unverifiedExtension },
    },
    discoveredCommands: [],
  };
}

export function materializeAuggieSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!auggieSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Auggie session adapter does not support surface '${ctx.surface}'`);
  }

  const env = definedEnv(bundle);
  if (ctx.surface === 'acp') {
    const mcpServers = sessionMcpProtocolServers(bundle, 'Auggie');
    const prompt = sessionContextPrompt(bundle.promptBlocks);
    for (const server of bundle.mcpServers) {
      if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
    }
    return {
      argsAppend: [],
      env,
      acp: { mcpServers },
      ...(prompt ? { prompt } : {}),
      configMerges: [],
      artifacts: [],
      report: report(ctx, Boolean(prompt)),
    };
  }

  return {
    argsAppend: tuiArgs(bundle),
    env,
    configMerges: [],
    artifacts: [],
    report: report(ctx, false),
  };
}
