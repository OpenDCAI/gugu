import {
  join,
} from 'node:path';
import { PLATFORM_NOT_WIRED, TUI_INTERRUPT_PAUSE } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
  SessionMcpServer,
} from '@gugu/session-core/agents/plugins';
import {
  assertSessionMcpStdioEnv,
  sessionMcpAuthorization,
  sessionMcpStdioConfig,
} from '../../helpers/session-mcp';

const VERSION = '1.17.0';
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Command Code v${VERSION} ${unit} delivery has not been verified from its published source.`,
});
const unverifiedModel = unverified('model');
const unverifiedAutonomy = unverified('autonomy');
const unverifiedPrompt = unverified('system-prompt');
const unverifiedExtension = unverified('extension');

export const commandcodeSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  surfaces: ['tui'],
  sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'local-session' } },
  units: {
    mcp: { kind: 'native', channel: 'workspace-config' },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'none', degraded: unverifiedModel },
    autonomy: { kind: 'none', degraded: unverifiedAutonomy },
    promptBlocks: { kind: 'none', degraded: unverifiedPrompt },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  coexistence: {
    /**
     * TUI 腿的回传通道(主干见 `session-core/.../capabilities/tui-coexistence.ts`):
     * `hooks.ts` 的 `buildCommandCodeHookConfig()` 往 `.commandcode/settings.json` 写两条
     * `Stop` hook(`makeStdinHookCommand('session'|'stop')`,由
     * `hook-config-service.ts:63 ensureHooksInstalled` 每次 spawn 前写盘),引擎在回合结束时
     * 执行它们 → POST 到 `GUGU_HOOK_PORT` 的 `/hook` → 宿主 `hook-server.ts` →
     * `event-enricher.ts` → `agent-hook-service.ts:317` 落成 `conversations.agentStatus`。
     * 引擎自己的 hook 系统推出来的,故是 `event-stream`。
     *
     * ⚠️ 只报 stop / session,**没有**原生 start(`supportedEvents` = ['session','stop'])。
     * 「本轮在飞」那一半是宿主从「用户按了回车」推的,不在本条声明里。
     */
    observability: { kind: 'native', channel: 'event-stream' },
    /**
     * TUI 腿的暂停 = 往 pty 写这一家的中断键(键位与出处见本 descriptor 末尾的
     * `sessionTuiInterrupt`;主干在 `session-core/.../capabilities/tui-coexistence.ts`)。
     * ⚠️ 字面量不自己手写,取主干常量 —— 通道名一旦漂,读侧就认不出这是同一条通道。
     */
    pause: TUI_INTERRUPT_PAUSE,
    // 引擎自己会去读的记忆文件已登记在 `index.ts` 的 `capabilities.memory`,宿主经
    // `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `agents-md`:Command Code 官方文档原文「Command Code reads AGENTS.md,
    // not CLAUDE.md」,它走的正是跨厂商的 AGENTS.md 约定,没有自己的专名记忆文件。
    memory: { kind: 'native', channel: 'agents-md' },
  },
  /**
   * TUI 腿的中断键。
   *
   * 出处:https://commandcode.ai/docs/interactive-mode 的快捷键表(取证 2026-08-24)——
   * `esc` = "Stop what's running";`esc` `esc` = "Rewind to a previous checkpoint
   * (same as /rewind)"。
   *
   * ⚠️ 因此 `presses` **必须**是 1(缺省值),❌ 绝不能写 2:在这一家,双击 Esc 不是「更用力地
   * 中断」,而是**回滚到上一个检查点** —— 那会把用户这一轮的改动撤掉,而界面只报「已暂停」。
   * 这正是本字段强制带 evidence 的理由。
   * ⚠️ 同理,宿主若在极短时间内连调两次 interrupt(),两个 Esc 会被引擎读成 rewind;
   * 那是宿主侧的调用节奏问题,不在本声明能表达的范围内。
   * ❌ 不用 Ctrl-C:同一份文档里 Ctrl-C 的语义是清空输入框与待发附件,不是中断本轮。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      'Command Code 交互模式快捷键表:esc = "Stop what\'s running",esc esc = "Rewind to a '
      + 'previous checkpoint" — https://commandcode.ai/docs/interactive-mode (取证 2026-08-24)',
  },
  // ❌ 其余各维不写:落回 BASE_SESSION_COEXISTENCE。
  // 只有 tui 一条腿:没有 ACP,于是协议 cancel / plan / 授权往返 / 会话状态机全都不适用。
  // ⚠️ 上面 units.mcp 是 native 只说明咕咕**写**得进 workspace 的 .mcp.json;index.ts 没注册
  // mcp behavior,所以没有 readServers 那条**读**用户 MCP 表的路 → introspection 不成立。
  // hooks 有,但 readHooks 只认 GUGU_HOOK_MARKER —— 报的是「咕咕自己装没装」,不是用户的 hooks。
  // 也不在 transcriptInventory 的两家(claude-code / codex)扫描名单里 → history 不成立。
  // ⚠️ 这些都只说明**咕咕没接**;厂商有没有见 #3889 的官方证据矩阵,勿据此推断。
} satisfies SessionBundleDescriptor;

function serverConfig(server: SessionMcpServer, bundle: SessionCapabilityBundle) {
  if (server.transport === 'stdio') {
    assertSessionMcpStdioEnv(server, bundle, 'Command Code');
    return sessionMcpStdioConfig(server);
  }
  sessionMcpAuthorization(server, bundle.env, 'Command Code');
  return {
    transport: 'http',
    url: server.url,
    ...(server.authorizationEnv
      ? { headers: { Authorization: `\${${server.authorizationEnv}}` } }
      : {}),
  };
}

function report(ctx: SessionMaterializationContext): SessionMaterialization['report'] {
  const loaded = { status: 'loaded' as const };
  return {
    adapterId: 'commandcode',
    surface: ctx.surface,
    units: {
      mcp: loaded,
      env: loaded,
      model: { status: 'degraded', reason: unverifiedModel },
      autonomy: { status: 'degraded', reason: unverifiedAutonomy },
      promptBlocks: { status: 'degraded', reason: unverifiedPrompt },
      packages: { status: 'degraded', reason: unverifiedExtension },
    },
    discoveredCommands: [],
  };
}

export function materializeCommandcodeSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!commandcodeSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Command Code session adapter does not support surface '${ctx.surface}'`);
  }
  return {
    argsAppend: [],
    env: Object.fromEntries(
      Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
    configMerges: [{
      kind: 'json-merge',
      path: join(ctx.cwd, '.mcp.json'),
      patch: {
        mcpServers: Object.fromEntries(
          bundle.mcpServers.map((server) => [server.name, serverConfig(server, bundle)])
        ),
      },
      conflict: 'fail',
      mode: 0o600,
    }],
    artifacts: [],
    report: report(ctx),
  };
}
