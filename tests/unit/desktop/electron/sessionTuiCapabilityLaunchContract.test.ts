// Vitest project: gugu.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSessionTuiSessionBundle,
  loadClaudeTuiCapabilities,
  loadSessionTuiCapabilities,
  PRODUCT_CAPABILITY_PACKAGES,
  type Materialization,
  type SessionCapabilityBundle,
  guguSessionSurfaceBlock,
} from '../../../../apps/desktop/electron/capability-bundle';
import {
  agentRequiresFreshPtyPrompt,
  type AgentCapabilities,
} from '../../../../apps/desktop/src/session/shared/core/agents/agent-payload';
import { pluginRegistry, resolveSessionTuiDeliveryToolNames } from '@gugu/session-plugins/agents';

// #3577：会话自述 = 平台常量 + 该 surface 的自述块；这张表的每一行都是 session-TUI。
// #6192：自述块里还有这一家 harness 的工具名那一行,所以按 provider 合成。
const promptFor = (providerId: string) =>
  `<gugu_platform>P</gugu_platform>\n${guguSessionSurfaceBlock('tui', providerId, false)}<agent_identity>A</agent_identity>\n`;
const PROMPT = promptFor('claude');
const CWD = '/tmp/gugu-tui-launch-contract';
const GUGU_HOME = '/tmp/gugu-tui-launch-contract-home';

function bundle(prompt = PROMPT): SessionCapabilityBundle {
  return {
    mcpServers: [],
    mcpDisabled: undefined,
    env: { GUGU_HOME, SAFE_ENV: 'positive-control' },
    model: null,
    autonomy: null,
    promptBlocks: prompt
      ? {
          platform: '<gugu_platform>P</gugu_platform>\n',
          identity: '<agent_identity>A</agent_identity>\n',
        }
      : {},
    packages: PRODUCT_CAPABILITY_PACKAGES,
    extensionSkills: [],
    extensionApps: [],
    extensionServerOrigins: [],
  };
}

function sourceBlock(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start);
  expect(start, startToken).toBeGreaterThan(-1);
  expect(end, endToken).toBeGreaterThan(start);
  return source.slice(start, end);
}

function hasDegradation(materialization: Materialization, unit: string): boolean {
  return materialization.report.degraded.some((entry) => entry.unit === unit);
}

describe('task-TUI capability launch contract', () => {
  it('keeps the empty fresh-PTY gate orthogonal to ordinary message delivery', () => {
    const capabilities = {
      sessions: { kind: 'resumable', freshPtyPrompt: 'required' },
    } as AgentCapabilities;
    expect(agentRequiresFreshPtyPrompt(capabilities)).toBe(true);
    expect(agentRequiresFreshPtyPrompt({ sessions: { kind: 'resumable' } } as AgentCapabilities))
      .toBe(false);
  });

  it('keeps every #3445 surface reading connected to its exact launch field', () => {
    // 这里守的是「PROMPT 确实是那段合成出来的自述，没有被悄悄清空/截断」。
    // ❌ 不再钉死字符数：surface 自述块是真实产品文案，钉死长度会让任何一次措辞调整
    // 在一个与它无关的启动契约测试上炸掉。改判结构：两端各自在场，且整体严格长于两端之和的下界。
    expect(PROMPT.startsWith('<gugu_platform>P</gugu_platform>\n')).toBe(true);
    expect(PROMPT.endsWith('<agent_identity>A</agent_identity>\n')).toBe(true);
    expect(PROMPT).toContain('<gugu_session_surface>');
    // F54 The session's own shape lives here, not in session_spawn's (shared) description.
    expect(PROMPT).toContain('a pty session running the harness TUI');
    expect(PROMPT.length).toBeGreaterThan(68);
    const ctx = { cwd: CWD, lifecycle: 'fresh' as const };
    // opencode 的终端腿自 #4406 起是实测申明 —— 这里从「断言拒绝」改为「断言接受具体形状」,
    // 契约钉在下面 checks 的 opencode 一行。
    const opencode = loadSessionTuiCapabilities('opencode', bundle(), ctx);
    const claude = loadClaudeTuiCapabilities(bundle(), ctx);
    const pi = loadSessionTuiCapabilities('pi', bundle(), ctx);
    const copilot = loadSessionTuiCapabilities('copilot', bundle(), ctx);
    const ohMyPi = loadSessionTuiCapabilities('oh-my-pi', bundle(), ctx);

    const hostSource = readFileSync(
      join(process.cwd(), 'apps/desktop/electron/sessionpage/session-tui-host-start.ts'),
      'utf8',
    );
    const claudeHook = sourceBlock(
      hostSource,
      'const startClaudeRendezvous: HostStart',
      'const startProviderSessionBundle: HostStart',
    );
    const providerHook = sourceBlock(
      hostSource,
      'const startProviderSessionBundle: HostStart',
      'const startCodexAppServer: HostStart',
    );
    const claudeConsumesNativeOutput =
      /args:\s*\[\s*\.\.\.info\.baseArgs,\s*\.\.\.\(capabilities\.extraArgs \?\? \[\]\),/.test(
        claudeHook,
      ) &&
      /env:\s*\{\s*\.\.\.\(capabilities\.spawnEnv \?\? \{\}\),/.test(claudeHook) &&
      claudeHook.includes('await materialize(info, bundle.env.GUGU_HOME, capabilities');
    const providerConsumesNativeOutput =
      /args:\s*\[\.\.\.info\.baseArgs,\s*\.\.\.\(capabilities\.extraArgs \?\? \[\]\)\]/.test(
        providerHook,
      ) &&
      providerHook.includes('env: capabilities.spawnEnv') &&
      providerHook.includes('await materialize(info, bundle.env.GUGU_HOME, capabilities)');
    const identityDoesNotGateProviderMaterialization =
      providerHook.includes('buildSessionTuiSessionBundle({ bootstrap, identity })') &&
      !providerHook.includes('return null');

    // claude 的系统提示走**提示档 + 路径**(#5852):argv 上只有指针,正文在 artifact 里。
    const appendIndex = claude.extraArgs?.indexOf('--append-system-prompt-file') ?? -1;
    const claudePromptFile = (claude.artifacts ?? []).find(
      (artifact) => artifact.path === claude.extraArgs?.[appendIndex + 1],
    );
    const piModule = (pi.artifacts ?? []).find((artifact) =>
      artifact.path.endsWith('/.pi/extensions/gugu-hook.ts'),
    );
    const checks = [
      {
        label: 'claude.tui.promptBlocks',
        passed:
          appendIndex >= 0 &&
          claudePromptFile?.content === promptFor('claude') &&
          claudePromptFile.mode === 0o600 &&
          claudePromptFile.path.startsWith(`${GUGU_HOME}/`) &&
          // 正文一个字都不上 argv —— argv 的长度因此与提示内容无关。
          claude.extraArgs?.some((arg) => arg.includes('<gugu_platform>')) === false &&
          claudeConsumesNativeOutput,
      },
      {
        label: 'pi.tui.promptBlocks',
        passed:
          pi.spawnEnv?.GUGU_PI_SYSTEM_PROMPT === promptFor('pi') &&
          // env 确实原样转发的阳性对照(下面 copilot 那条的前缀白名单要丢掉同一个键)。
          pi.spawnEnv?.SAFE_ENV === 'positive-control' &&
          piModule?.content.includes("pi.on('before_agent_start'") === true &&
          providerConsumesNativeOutput &&
          identityDoesNotGateProviderMaterialization,
      },
      {
        // copilot 自 2026-08-25 起接通了 env 这一维，所以这里**不再**是「什么都没投递」。
        // 判据是**键集逐字相等**：`GUGU_HOME` 要到，而 `SAFE_ENV` 不到 —— 后者正是
        // 前缀白名单的对照物（同一份 bundle 里 pi 那条用它当"env 确实转发了"的阳性对照，
        // 这里它被丢掉，两条合起来证明这个筛子既没全放也没全挡）。
        //
        // 2026-08-26 起这条腿的 promptBlocks 也接通了：一份 `*.instructions.md` 落进
        // run-scoped 目录，`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 指过去（实测读数见该家
        // session-bundle 的 units.promptBlocks）。所以键集多一条、artifacts 多一份，
        // 而 promptBlocks 不再是降级项。⚠️ 目录名里有 uuid，只比键集、不比值。
        label: 'copilot.tui.env',
        passed:
          hasDegradation(copilot, 'mcp') &&
          !hasDegradation(copilot, 'promptBlocks') &&
          copilot.extraArgs === undefined &&
          JSON.stringify(Object.keys(copilot.spawnEnv ?? {}).sort())
            === JSON.stringify(['COPILOT_CUSTOM_INSTRUCTIONS_DIRS', 'GUGU_HOME']) &&
          copilot.spawnEnv?.GUGU_HOME === GUGU_HOME &&
          (copilot.artifacts ?? []).length === 1 &&
          (copilot.artifacts ?? [])[0]?.path.endsWith('.instructions.md') === true &&
          // 变量指的是那份 artifact 所在的目录 —— 指错就等于什么都没投递（copilot 只扫目录）。
          (copilot.artifacts ?? [])[0]?.path.startsWith(
            `${copilot.spawnEnv?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS}/`,
          ) === true,
      },
      {
        // opencode:一切经 OPENCODE_CONFIG_CONTENT(model/permission/mcp/instructions 同一份
        // 配置文档)。自述落成 instructions 文件,config.instructions 指过去 —— 文件内容必须逐字
        // 等于 PROMPT(surface 块由装载器并入 platform)。⚠️ tui 走 serve/attach,event module
        // 在这条腿上零消费者 ⇒ **不物化**它(否则 OpenCode 把它当 plugin origin,`POST /session`
        // 卡在把 `@opencode-ai/plugin` 装进 workspace 的冷 npm 安装上、超时)。见 opencode-session-bundle。
        label: 'opencode.tui.promptBlocks',
        passed: (() => {
          const raw = opencode.spawnEnv?.OPENCODE_CONFIG_CONTENT;
          if (!raw) return false;
          const config = JSON.parse(raw) as { instructions?: string[] };
          const instructionsPath = config.instructions?.[0];
          const instructionsArtifact = (opencode.artifacts ?? []).find(
            (artifact) => artifact.path === instructionsPath,
          );
          const eventModule = (opencode.artifacts ?? []).find((artifact) =>
            artifact.path.endsWith('/.opencode/plugins/gugu-notifications.js'),
          );
          return (
            instructionsArtifact?.content === promptFor('opencode') &&
            eventModule === undefined &&
            providerConsumesNativeOutput
          );
        })(),
      },
      {
        label: 'oh-my-pi.tui.degraded',
        passed:
          hasDegradation(ohMyPi, 'mcp') &&
          hasDegradation(ohMyPi, 'promptBlocks') &&
          ohMyPi.extraArgs === undefined &&
          Object.keys(ohMyPi.spawnEnv ?? {}).length === 0 &&
          (ohMyPi.artifacts ?? []).length === 0,
      },
    ];

    expect(checks).toHaveLength(5);
    for (const check of checks) {
      expect.soft(check.passed, check.label).toBe(true);
    }
    expect(claudeHook).toContain('provisionTuiAgent(ctx, info, true)');
    expect(claudeHook).toContain('promoteSessionpageDeliveryOwner(');
    expect(claudeHook).toContain('emitSessionpageAgentProvisioned(provisioned.event)');
    expect(claudeHook.indexOf('promoteSessionpageDeliveryOwner(')).toBeLessThan(
      claudeHook.indexOf('emitSessionpageAgentProvisioned(provisioned.event)'),
    );
  });

  it('materializes the Pi task-TUI bundle when identity provisioning returns null', async () => {
    const identityless = await buildSessionTuiSessionBundle({
      bootstrap: {
        runtime: { authProvider: {} as never, env: { GUGU_HOME } },
        autonomy: null,
        additionalEnv: { SAFE_ENV: 'identity-independent' },
        promptBlocks: {},
      },
      identity: null,
    });
    const materialized = loadSessionTuiCapabilities(
      'pi',
      identityless,
      { cwd: CWD, lifecycle: 'fresh' },
    );

    expect(identityless.mcpServers).toEqual([]);
    expect(identityless.promptBlocks.identity).toBeUndefined();
    expect(materialized.spawnEnv?.SAFE_ENV).toBe('identity-independent');
    expect(materialized.spawnEnv?.GUGU_PI_SYSTEM_PROMPT).toContain('<gugu_platform>');
    expect(materialized.artifacts?.some((artifact) =>
      artifact.path.endsWith('/.pi/extensions/gugu-hook.ts'))).toBe(true);
  });
});

// #6192(原在 capabilityBundle.test.ts 与 session-plugins registry.test.ts,两份都被 #6177 删掉;这是 #6192 的核心
// 语义,挪到这里守而 ❌ 不复活整份文件):模型面工具名只由 harness 的 MCP 能力声明 `toolNames` 给出 ——
// 自述块那一行、投递记账的工具名都从它派生;没量过的家不写、不回落到裸名。
describe('harness tool naming comes only from capabilities.mcp.toolNames (#6192)', () => {
  it("renders this harness's tool naming from its MCP capability declaration", () => {
    expect(guguSessionSurfaceBlock('acp', 'qwen', true)).toContain(
      'Your harness lists each 咕咕 tool as `mcp__gugu__<tool>` (e.g. `mcp__gugu__message_send`)',
    );
    expect(guguSessionSurfaceBlock('tui', 'copilot', true)).toContain('`gugu-message_send`');
    expect(guguSessionSurfaceBlock('tui', 'pi', true)).toContain(
      'Your harness lists each 咕咕 tool as `mcp__gugu__<tool>` (e.g. `mcp__gugu__message_send`)',
    );
    // 按腿声明的家(#6335 Antigravity:两条腿两个程序):终端腿 `agy` 经 call_mcp_tool 以 (server, 裸名) 调;
    // 聊天面板腿没量过 ⇒ 不写这一行,❌ 借终端腿的答案。
    expect(guguSessionSurfaceBlock('tui', 'antigravity', true)).toContain(
      'call them through its `call_mcp_tool` tool with `ServerName` set to `gugu` and `ToolName` set to the bare tool name',
    )
    expect(guguSessionSurfaceBlock('acp', 'antigravity', true)).not.toContain('Your harness')
    // 阴控:没量过的家不写这一行,也不会沾上别家的形态
    const unmeasured = guguSessionSurfaceBlock('acp', 'amp', true);
    expect(unmeasured).not.toContain('Your harness');
    expect(unmeasured).not.toMatch(/mcp__|gugu_<tool>/);
    expect(() => guguSessionSurfaceBlock('acp', 'no-such-provider', true)).toThrow('Unknown agent plugin');
    // 阴控:这条会话没拿到咕咕那台 server ⇒ 不许说「你的 harness 这样命名咕咕工具」
    expect(guguSessionSurfaceBlock('acp', 'qwen', false)).not.toContain('Your harness');
  });

  it('derives delivery tool names from the harness MCP tool-name declaration', () => {
    expect(resolveSessionTuiDeliveryToolNames('codex')).toEqual({
      message: 'mcp__gugu__message_send',
    });
    expect(resolveSessionTuiDeliveryToolNames('claude')).toEqual({
      message: 'mcp__plugin_gugu-product_gugu__message_send',
    });
    expect(resolveSessionTuiDeliveryToolNames('pi')).toEqual({ message: 'mcp__gugu__message_send' });
  });

  // #6615 问题 11 —— Codex 0.156.1 聊天面板腿:咕咕工具收在 `mcp__gugu` 命名空间里、名字是裸的;
  // 自述块原先教的 `mcp__gugu__message_send` 在它的工具表里不存在(W-21 抓包)。终端腿没重量,原样。
  it('Codex chat panel: gugu tools in the mcp__gugu namespace under bare names; the terminal leg keeps its measured form', () => {
    const chat = guguSessionSurfaceBlock('acp', 'codex', true);
    expect(chat).toContain(
      'Your harness exposes 咕咕 tools under `mcp__gugu`; follow each tool definition\'s advertised invocation form.',
    );
    expect(chat).not.toContain('mcp__gugu__');
    // 聊天面板的 app-server 形态读的是同一条腿
    expect(guguSessionSurfaceBlock('app-server', 'codex', true)).toContain('in its `mcp__gugu` namespace');
    expect(guguSessionSurfaceBlock('tui', 'codex', true)).toContain(
      'Your harness lists each 咕咕 tool as `mcp__gugu__<tool>` (e.g. `mcp__gugu__message_send`)',
    );
  });

  it('mutation: a namespaced terminal leg makes delivery name the bare tool, never `<namespace>__<tool>`', () => {
    const mcp = pluginRegistry.get('codex')!.capabilities.mcp;
    if (mcp.kind !== 'supported') throw new Error('codex must declare MCP support');
    const original = mcp.toolNames;
    try {
      mcp.toolNames = { kind: 'namespaced', namespace: 'mcp__gugu', evidence: 'test' };
      expect(resolveSessionTuiDeliveryToolNames('codex')).toEqual({ message: 'message_send' });
    } finally {
      mcp.toolNames = original;
    }
  });

  it('mutation: an unmeasured MCP tool-name declaration fails loud instead of falling back to bare names', () => {
    const mcp = pluginRegistry.get('claude')!.capabilities.mcp;
    if (mcp.kind !== 'supported') throw new Error('claude must declare MCP support');
    const original = mcp.toolNames;
    try {
      mcp.toolNames = { kind: 'unmeasured' };
      expect(() => resolveSessionTuiDeliveryToolNames('claude')).toThrow('has no measured MCP tool names');
    } finally {
      mcp.toolNames = original;
    }
  });
});
