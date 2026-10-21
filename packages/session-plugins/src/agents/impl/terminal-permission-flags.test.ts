import { describe, expect, it } from 'vitest';
import { GUGU_PERMISSION_MODES, type GuguPermissionMode } from '@gugu/session-core/acp';
import { pluginRegistry } from '../registry';
import { ANTIGRAVITY_SESSION_TUI_ENABLED } from './antigravity/session-bundle';

/**
 * 终端腿:档位表里声明、且终端腿兑现得了的每一档,argv 上带的**正是这一档的旗标**,新起与 resume 都一样。
 *
 * 「不加旗标 = 这家的某一档」不成立:不加旗标时 harness 自己挑启动档(claude 读用户的 defaultMode,
 * 再没有就是账号默认档 —— Max 账号实测 `auto`,#7366)。所以每一格都要逐字对上一个旗标。
 *
 * 期望表是**独立于命令构造器手抄的**(出处:各家 `--help`,版本见各家 index.ts)。它故意不和 buildCommand
 * 共用一张表:共用时,把 gemini 的编辑档接成 `yolo` 这种错会同时改掉期望,判据就打不红了。
 * ⚠️ 不能直接拿档位表的 `id` 当期望:那是 ACP 腿的拼法,终端腿的旗标常常不同(gemini `autoEdit` ↔ `auto_edit`、
 * claude 完全访问 `bypassPermissions` ↔ `--dangerously-skip-permissions`)。
 */
const EXPECTED: Record<string, Partial<Record<GuguPermissionMode, readonly string[]>>> = {
  claude: {
    plan: ['--permission-mode', 'plan'],
    'read-only': ['--permission-mode', 'default'],
    edit: ['--permission-mode', 'acceptEdits'],
    'full-access': ['--dangerously-skip-permissions'],
  },
  // codebuddy(#7525):档名与 Claude 同(`codebuddy --help`「--permission-mode … acceptEdits, bypassPermissions, default, plan」)。
  codebuddy: {
    plan: ['--permission-mode', 'plan'],
    'read-only': ['--permission-mode', 'default'],
    edit: ['--permission-mode', 'acceptEdits'],
    'full-access': ['--permission-mode', 'bypassPermissions'],
  },
  antigravity: { edit: ['--mode', 'accept-edits'], 'full-access': ['--dangerously-skip-permissions'] },
  gemini: {
    plan: ['--approval-mode=plan'],
    edit: ['--approval-mode=auto_edit'],
    'full-access': ['--approval-mode=yolo'],
  },
  cursor: { plan: ['--plan'], 'read-only': ['--mode', 'ask'], 'full-access': ['-f', '--approve-mcps'] },
  qwen: {
    plan: ['--approval-mode=plan'],
    'read-only': ['--approval-mode=default'],
    'full-access': ['--approval-mode=yolo'],
  },
  kimi: { plan: ['--plan'], 'full-access': ['--yolo'] },
  hermes: { 'full-access': ['--yolo'] },
  opencode: { plan: ['--agent', 'plan'] },
  codex: {
    'read-only': ['-s', 'read-only'],
    'full-access': ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'],
  },
  droid: { 'full-access': ['--auto', 'high'] },
};

/** 终端腿不在 argv 上兑现的格,每条写明理由。 */
const NOT_ON_ARGV: Record<string, { modes: readonly GuguPermissionMode[]; reason: string }> = {
  codex: { modes: ['edit'], reason: '终端腿走 app-server,三档由会话包写成 sandbox + approval(codex/session-bundle.ts)' },
  opencode: { modes: ['edit'], reason: '档位由会话包写进 OPENCODE 配置的 permission 规则' },
  kimi: { modes: ['edit'], reason: 'kimi 0.40.1 --help 只有 --yolo/--auto/--plan,没有「每次都问」的旗标' },
  hermes: { modes: ['edit'], reason: 'hermes v0.21.0 --help 只有 --yolo,没有「每次都问」的旗标' },
};

function argv(id: string, permissionMode: GuguPermissionMode | undefined, isResuming: boolean): string[] {
  return pluginRegistry.get(id)!.behavior.prompt!.buildCommand({
    cli: `/bin/${id}`,
    ...(permissionMode !== undefined && { permissionMode }),
    cliSessionId: 'cli-session',
    providerSessionId: 'provider-session',
    isResuming,
    model: '',
  }).args;
}

function containsRun(args: readonly string[], run: readonly string[]): boolean {
  return args.some((_, i) => run.every((token, j) => args[i + j] === token));
}

const cells = pluginRegistry.getAll().flatMap((provider) => {
  const autoApprove = provider.capabilities.autoApprove;
  if (!provider.behavior.prompt?.buildCommand || autoApprove.kind !== 'supported') return [];
  // Windows 上 antigravity 的终端腿不开,buildCommand 会抛。
  if (provider.metadata.id === 'antigravity' && !ANTIGRAVITY_SESSION_TUI_ENABLED) return [];
  return GUGU_PERMISSION_MODES
    .filter((mode) => {
      const entry = autoApprove.modes?.[mode];
      return entry && (!entry.legs || entry.legs.includes('tui'));
    })
    .flatMap((mode) => [false, true].map((isResuming) => ({ id: provider.metadata.id, mode, isResuming })));
});

describe('终端腿:每一档的 argv 带的正是这一档的旗标', () => {
  it('扫到了这次出事的那几格,且每一格都有期望或写明理由的豁免', () => {
    expect(cells).toEqual(expect.arrayContaining([
      { id: 'claude', mode: 'read-only', isResuming: false },
      { id: 'claude', mode: 'read-only', isResuming: true },
      { id: 'gemini', mode: 'edit', isResuming: false },
      { id: 'kimi', mode: 'plan', isResuming: true },
    ]));
    const uncovered = cells.filter(({ id, mode }) => !EXPECTED[id]?.[mode] && !NOT_ON_ARGV[id]?.modes.includes(mode));
    expect(uncovered).toEqual([]);
  });

  it.each(cells)('$id / $mode / resume=$isResuming', ({ id, mode, isResuming }) => {
    const expected = EXPECTED[id]?.[mode];
    if (!expected) return; // NOT_ON_ARGV,理由见表
    const args = argv(id, mode, isResuming);
    expect(containsRun(args, expected), `${id}/${mode}: ${args.join(' ')}`).toBe(true);
  });

  it('没有档位的记录(导入的会话)按编辑档,照样显式推旗标', () => {
    expect(containsRun(argv('claude', undefined, false), ['--permission-mode', 'acceptEdits'])).toBe(true);
    expect(containsRun(argv('claude', undefined, true), ['--permission-mode', 'acceptEdits'])).toBe(true);
  });

  it.runIf(ANTIGRAVITY_SESSION_TUI_ENABLED)('antigravity 的只读只在聊天面板腿:终端腿递进来就抛', () => {
    expect(() => argv('antigravity', 'read-only', false)).toThrow(/no read-only mode on the terminal leg/);
  });
});
