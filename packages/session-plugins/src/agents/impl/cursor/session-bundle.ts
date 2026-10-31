import { PLATFORM_NOT_WIRED } from '@gugu/session-core/agents/plugins';
import type {
  Degradation,
  SessionBundleDescriptor,
  SessionCapabilityBundle,
  SessionMaterialization,
  SessionMaterializationContext,
} from '@gugu/session-core/agents/plugins';
import {
  materializeAcpSessionBundle,
  sessionContextPrompt,
} from '../../helpers/session-bundle';

export const CURSOR_ACP_VERSION = '2026.08.31-4057e58';
export const CURSOR_ACP_SOURCE =
  'Cursor Agent 2026.08.31-4057e58 package (read on macOS): 6863.index.js:1 ./src/acp/cursor-acp-agent.ts (byte 46030) and ./src/acp/session-resources.ts (byte 80881); 8096.index.js:2 dispatcher (byte 2248118) accepts session/new and session/prompt; session/new.mcpServers is consumed per server, failures are caught and session creation continues.';

const unverified = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Cursor Agent ${CURSOR_ACP_VERSION} ${unit} delivery is UNMEASURED because a Cursor vendor account is required for a real turn.`,
});

/** 见下面 `units.model` 抬头:这是查证后的终局,不是「还没查」。 */
const vendorClosedModel: Degradation = {
  code: 'unsupported-channel',
  reason:
    'Cursor 主线 CLI 不接受外部推理端点：--base-url 被硬拒（仅 agent-cli-local 可用），'
    + '--endpoint 指向的是 Cursor 私有 Connect-RPC（aiserver.v1.*），不是 OpenAI 兼容协议。'
    + '⇒ 用户用自己的 Cursor 额度，这是正确的终局状态，不是待办。',
};

const unverifiedTui = (unit: string): Degradation => ({
  code: 'unverified',
  reason: `Cursor Agent ${CURSOR_ACP_VERSION} session-TUI ${unit} has no direct session adapter; this leg remains unavailable.`,
});

export const cursorSessionBundleDescriptor = {
  injectionMode: 'runtime',
  platform: PLATFORM_NOT_WIRED,
  shellEnv: { passThrough: ['CURSOR_API_KEY'] },
  surfaces: ['acp', 'tui'],
  sessionpage: {
    'acp': {
      identity: 'addressable',
      messageTransport: 'router',
      injection: {
        timing: 'idle-only',
        evidence: 'https://github.com/nmhjklnm/gugu/issues/4769',
        deviations: 'Cursor 2026.08.31-4057e58 忙时第二条标准 session/prompt 会取消在飞回合（首条 stopReason=cancelled、工具未执行），不是 next-tool-call；宿主直接尝试注入，若仅得到 queued 则响亮失败。',
      },
    },
    'tui': {
      identity: 'none',
      messageTransport: 'none',
      reason:
        `Cursor Agent ${CURSOR_ACP_VERSION} session-TUI creation reached hydration, but the packaged app logged `
        + `"Provider 'cursor' has no direct session-TUI session adapter"; no inbound channel is declared.`,
    },
  },
  units: {
    mcp: {
      kind: 'per-surface',
      surfaces: {
        // Current MCP probe only reached initialize; Cursor disconnected before
        // tools/list. Keep the capability unverified until protocol-version
        // aligned server A/B proves list and tools/call delivery.
        'acp': { kind: 'none', degraded: unverified('MCP initialize only; tools/list/tools/call not observed') },
        'tui': { kind: 'none', degraded: unverifiedTui('MCP') },
      },
    },
    env: { kind: 'native', channel: 'child-process' },
    // ⚠️ 这一格是**终局,不是欠账** —— 别改回 `unverified('model')`。
    //
    // owner 2026-08-25:「cursor 本来就不支持自定义模型,相当于咱们注入不进去。
    //                     但是用户可以用自己的 cursor 额度。」
    //
    // 2026-08-25 一手实测(见答案键 `modelAccess` 那一格与 __provenance__.modelAccessSurvey):
    //  · 主线二进制跑 `--base-url` → `can only be used with agent-cli-local`,当场硬拒;
    //  · 把 `--endpoint` 指到本地服务后抓包,收到 `aiserver.v1.DashboardService/GetMe` 一类,
    //    头是 `application/proto` + `connect-protocol-version: 1`(Cursor 私有 Connect-RPC),
    //    全程 **0 次** `/v1/chat/completions`。
    // ⇒ 所以用 `unsupported-channel` 而不是 `unverified`:后者说的是「咕咕没验过」,
    //   而我们验过了,结论是厂商不开放。这两句话对读代码的人是完全不同的指示 ——
    //   `unverified` 会让下一个人再查一遍,并把它当成待办排进工期。
    //
    // ❌ 用 `unsupported-channel` 是有举证门槛的(#3889 红线:本仓 grep 不到只能证明咕咕没接)。
    //    答案键里厂商那一格必须真的是 `none`。别在没有厂商侧证据时照抄这个写法。
    model: { kind: 'none', degraded: vendorClosedModel },
    // Session/set_mode behavior is measured and represented by index.ts autoApprove.modes;
    // this unit remains none because autonomy is carried by those provider mode semantics rather
    // than a separate process-level channel.
    autonomy: { kind: 'none', degraded: unverified('autonomy (ACP session-mode runtime)') },
    promptBlocks: {
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'session-context' },
        'tui': { kind: 'none', degraded: unverifiedTui('system-prompt') },
      },
    },
  },
  extension: { kind: 'none', degraded: unverified('extension') },
  coexistence: {
    // ACP `session/cancel` is a notification (no JSON-RPC id); the driver must
    // send it as such and observe the prompt result stopReason=cancelled.
    pause: { kind: 'native', channel: 'protocol-cancel' },
    // acp leg: `projectSessionState` reports the live turn — `isGenerating` / `canCancel` /
    // `lifecycle` (session-runtime/src/acp-agents/machine/machine.ts:410,413).
    observability: { kind: 'native', channel: 'acp-update' },
    // acp leg: authorization-type asks round-trip to the human — the agent's
    // `session/request_permission` becomes a pending request with options
    // (session-runtime/src/acp-agents/session/cell.ts:318), surfaces in the UI
    // (session-chat-ui/src/state/chat-state.ts:364), and the user's pick settles it (cell.ts:299).
    // ❌ Not the clarification-type ask (`mcp-elicitation` / `native-tool`): Gugu has no such route.
    // Short mode probes emitted zero request_permission calls; a long task did
    // emit one and was answered, so this channel is real and task-dependent.
    askUser: { kind: 'native', channel: 'permission-ask' },
    // `cursorMcpAdapter()` scans the user's own ~/.cursor/mcp.json and enumerates every entry it
    // finds, Gugu-authored or not (agents/plugins/helpers/mcp.ts:145,208 via plugin-host.ts:231).
    introspection: { kind: 'native', channel: 'config-scan' },
    // acp leg: `plan` session updates are normalized into structured entries, not prose
    // (acp/reducer/normalized-event.ts:155).
    todo: { kind: 'native', channel: 'acp-plan' },
    // 引擎自己会去读的规则文件已登记在 `index.ts` 的 `capabilities.memory`,宿主经
    // `AgentPluginHost.readMemoryFiles` 按那份登记读回 → 这一维接通。
    // channel 取 `vendor-file`:cursor 的主力是它自己的 `.cursor/rules/*.mdc`
    // (登记里同时有 `AGENTS.md`,走 agents-md)。
    memory: { kind: 'native', channel: 'vendor-file' },
  },
  /*
   * ❌ 没有 `sessionTuiInterrupt` —— 这是**取不到一手出处**,不是「cursor 做不到」。
   *
   * 规则上它现在填得下(双腿家声明中断键不再要求同步 `pause`,判据见 tui-coexistence.ts 的
   * `tuiInterruptSurfaceRequirement`),缺的是证据:
   *  · https://cursor.com/docs/cli/overview 与 https://cursor.com/docs/reference/keyboard-shortcuts
   *    都**没有** cursor-agent 的中断键位(后者整页只讲编辑器);
   *  · 唯一流传的说法是「Enter 一下 steer、再一下 interrupt」,只见于第三方 cheatsheet,
   *    官方零出处;
   *  · #3889 答案键那格写「Enter 两次中断」—— 那一列是**二手转述**,`zero.pause` 已被查出
   *    把 Esc / Ctrl-C 记反,❌ 不能当出处。
   *
   * ⚠️ 而这一家填错的代价比别家更高:候选键是 `\r`。若用户输入框里还留着半句话,写 `\r`
   * 就是**替他把那半句话发出去** —— 不是「没停下」,是凭空多出一轮对话。
   * 取到官方键位表(或 cursor-agent 的源码/发行说明)再补。
   */
} satisfies SessionBundleDescriptor;

export function materializeCursorSessionBundle(
  ctx: SessionMaterializationContext,
  bundle: SessionCapabilityBundle
): SessionMaterialization {
  const base = materializeAcpSessionBundle('cursor', cursorSessionBundleDescriptor, ctx, bundle);
  const prompt = ctx.surface === 'acp' ? sessionContextPrompt(bundle.promptBlocks) : undefined;
  return prompt ? { ...base, prompt } : base;
}

export const cursorSessionBundleBehavior = {
  materialize: materializeCursorSessionBundle,
};
