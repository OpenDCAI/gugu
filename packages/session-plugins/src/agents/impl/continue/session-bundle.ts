import { PLATFORM_NOT_WIRED, TUI_INTERRUPT_PAUSE } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';

/**
 * Continue CLI 源码取证的锚点(取证 2026-08-24)。
 *
 * 钉 sha 而不是 `main`:上游改一次键位或改一次记忆文件清单,`main` 上的行号与内容就变了,
 * 而这份声明是往用户 pty 里写字节的依据 —— 复核不到原始那一版就等于没取证。
 */
export const CONTINUE_CLI_SOURCE_SHA = '5522c6f44ca0ac3528b37244818fbfa39b5af470';

const VERSION = '1.5.47';
const unsupportedMcp: Degradation = {
  code: 'unsupported-channel',
  reason:
    `Continue CLI v${VERSION} has no additive per-session MCP channel: --config replaces the selected assistant config and the published --mcp Hub loader is removed.`,
};
const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Continue CLI v${VERSION} ${unit} delivery has not been verified from its published source.`,
});
const unverifiedModel = unverified('model');
const unverifiedAutonomy = unverified('autonomy');
const unverifiedPrompt = unverified('system-prompt');
const unverifiedExtension = unverified('extension');

export const continueSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  surfaces: ['tui'],
  sessionpage: { 'tui': { identity: 'addressable', messageTransport: 'local-session' } },
  units: {
    mcp: { kind: 'none', degraded: unsupportedMcp },
    env: { kind: 'native', channel: 'child-process' },
    model: { kind: 'none', degraded: unverifiedModel },
    autonomy: { kind: 'none', degraded: unverifiedAutonomy },
    promptBlocks: { kind: 'none', degraded: unverifiedPrompt },
  },
  extension: { kind: 'none', degraded: unverifiedExtension },
  // 只写咕咕**真接通了**的维度;没写的落回 BASE_SESSION_COEXISTENCE(= 尚未接通)。
  coexistence: {
    /**
     * TUI 腿的暂停 = 往 pty 写这一家的中断键(键位与出处见本 descriptor 末尾的
     * `sessionTuiInterrupt`;主干在 `session-core/.../capabilities/tui-coexistence.ts`)。
     * ⚠️ 字面量不自己手写,取主干常量 —— 通道名一旦漂,读侧就认不出这是同一条通道。
     */
    pause: TUI_INTERRUPT_PAUSE,
    // 引擎自己会去读的记忆文件已登记在 `index.ts` 的 `capabilities.memory`,宿主经
    // `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `vendor-file`:Continue 的主力是它自己的 `.continue/rules` 目录;
    // 同时也登记了 `AGENTS.md`(agents-md),两条通道都在登记里,考卷取其一即可。
    memory: { kind: 'native', channel: 'vendor-file' },
  },
  /**
   * TUI 腿的中断键。
   *
   * 出处:`continuedev/continue@5522c6f4` 的 `extensions/cli/src/ui/UserInput.tsx`
   * `handleEscapeKey()`(取证 2026-08-24):`if (!key.escape) return false;` 之后,
   * 注释 "Handle escape key to interrupt streaming" 那一段是
   * `if (isWaitingForResponse && onInterrupt) { onInterrupt(); return true; }` ——
   * 正在流式回复时按 Esc 打断本轮,进程与会话都留着。
   *
   * ❌ 不用 Ctrl-C:同文件的 Ink `useInput` 把 ctrl+c 交给终端默认处置(退出),那是**停止**
   * 不是暂停 —— 按错级别的代价是用户点「暂停」却把会话杀了。
   * 单按即中断(源码里没有任何双击计数),故不设 presses / intervalMs。
   */
  sessionTuiInterrupt: {
    sequence: '\u001b',
    evidence:
      `continuedev/continue@${CONTINUE_CLI_SOURCE_SHA} `
      + 'extensions/cli/src/ui/UserInput.tsx handleEscapeKey(): '
      + '"Handle escape key to interrupt streaming" → isWaitingForResponse && onInterrupt() '
      + '(取证 2026-08-24)',
  },
  // ❌ 其余各维不写:落回 BASE_SESSION_COEXISTENCE。
  // 只有 tui 一条腿:没有 ACP,于是协议 cancel / plan / 授权往返 / 会话状态机全都不适用。
  // index.ts 既没注册 mcp behavior(无 readServers → 读不到用户的 MCP 表)也没注册 hooks
  // (`hooks` descriptor 是 `none` → 没有回传链,不许声明 observability:event-stream),
  // 也不在 transcriptInventory 的两家(claude-code / codex)扫描名单里。
  // ⚠️ 这些都只说明**咕咕没接**;厂商有没有见 #3889 的官方证据矩阵,勿据此推断。
} satisfies SessionBundleDescriptor;

export function materializeContinueSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  if (!continueSessionBundleDescriptor.surfaces.includes(ctx.surface as never)) {
    throw new Error(`Continue session adapter does not support surface '${ctx.surface}'`);
  }
  const env = Object.fromEntries(
    Object.entries(bundle.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  for (const server of bundle.mcpServers) {
    if (server.transport !== 'stdio' && server.authorizationEnv) delete env[server.authorizationEnv];
    if (server.transport === 'stdio') {
      for (const ref of Object.values(server.env ?? {})) delete env[ref];
    }
  }
  const loaded = { status: 'loaded' as const };
  return {
    argsAppend: [],
    env,
    configMerges: [],
    artifacts: [],
    report: {
      adapterId: 'continue',
      surface: ctx.surface,
      units: {
        mcp: { status: 'degraded', reason: unsupportedMcp },
        env: loaded,
        model: { status: 'degraded', reason: unverifiedModel },
        autonomy: { status: 'degraded', reason: unverifiedAutonomy },
        promptBlocks: { status: 'degraded', reason: unverifiedPrompt },
        packages: { status: 'degraded', reason: unverifiedExtension },
      },
      discoveredCommands: [],
    },
  };
}
