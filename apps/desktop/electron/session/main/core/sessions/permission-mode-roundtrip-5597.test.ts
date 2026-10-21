import { describe, expect, it } from 'vitest';
import { buildSessionRow } from './build-session-row';
import { mapSessionRowToSession } from './utils';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import {
  GUGU_PERMISSION_MODES,
  resolveDeclaredPermissionMode,
  type GuguPermissionMode,
} from '@gugu/session-core/acp';

/**
 * #5597 第三处病根:**写入端写了档,读取端没读回来。**
 *
 * `build-session-row` 老老实实把 `permissionMode` 写进 config,而行 → Conversation 的
 * **唯一**映射器当时没读它。于是每个从行上读档的消费者都拿到 `undefined`,下游把它当成
 * 「这条会话没显式选过档」—— 终端腿的 argv 因此一个权限 flag 都不推(实测:选 plan 的
 * claude Code 腿 argv 上什么都没有)。
 *
 * 判据形状是**往返**(写进去 → 读回来),❌ 不是「映射器有没有这一行」:
 * 后者可以被一个抄错键名的实现满足。
 */
function row(input: Parameters<typeof buildSessionRow>[0]) {
  const built = buildSessionRow(input);
  // buildSessionRow 产出的是 insert 值;补上映射器要读的行字段(它们不参与本判据)。
  return {
    ...built,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    lastInteractedAt: null,
    agentStatus: null,
    agentStatusSeen: 1,
    isPinned: 0,
    parentSessionId: null,
    spawnedBySessionId: null,
  } as never;
}

const base = {
  id: 'c1',
  projectId: 'p1',
  workspaceId: 'w1',
  title: 'T',
  provider: 'claude' as never,
  origin: { kind: 'create' as const, firstUtterance: 'hi' },
  claimsFirstSpawn: false,
};

describe('落库的权限档必须能读回来(#5597)', () => {
  for (const runtime of ['pty', 'acp'] as const) {
    it.each(['plan', 'read-only', 'edit', 'full-access'] as const)(
      `${runtime} 会话:写进去的 %s 原样读回来`,
      (mode) => {
        const session = mapSessionRowToSession(
          row({ ...base, runtime, permissionMode: mode }),
        );
        expect(session.permissionMode).toBe(mode);
      },
    );

    // 阴控:没写档的行读回来必须**仍然没有** permissionMode —— 映射器❌不许替它补一个档
    // (缺席怎么算是 resolveSessionPermissionMode 的事,只有一处)。
    it(`${runtime} 会话:没写档的行不得凭空长出一个档`, () => {
      const session = mapSessionRowToSession(row({ ...base, runtime }));
      expect(session.permissionMode).toBeUndefined();
    });
  }
});

// ── #6221:选的档必须是引擎**真能兑现**的档 ─────────────────────────────────────────────
// 落库的档读得回来(上面)还不够:qwen 的 Edit 从前一个 flag 都不发,而 qwen 0.24.4 无 flag 起始是 `auto`
// (工作区内写入不问);cursor 的 Edit 同样不发 flag,落进 cursor 自家的全权 agent 模式。两家都比所选更松。
// 判据走**注册表里的** provider(终端腿三条路都经它拿命令)与真档位表,❌ 不用手写的假表。
function argv(providerId: string, permissionMode: GuguPermissionMode | undefined): string[] {
  return pluginRegistry.get(providerId)!.behavior.prompt!.buildCommand({
    cli: `/usr/local/bin/${providerId}`,
    ...(permissionMode !== undefined && { permissionMode }),
    model: '',
  }).args;
}

describe('终端腿只收得到这一家档位表里的档(#6221)', () => {
  it('qwen:Edit 与只读都落到 --approval-mode=default(编辑与 shell 都问),规划 = plan,完全访问 = yolo', () => {
    expect(argv('qwen', 'edit')).toContain('--approval-mode=default');
    expect(argv('qwen', 'read-only')).toContain('--approval-mode=default');
    expect(argv('qwen', 'plan')).toContain('--approval-mode=plan');
    expect(argv('qwen', 'full-access')).toContain('--approval-mode=yolo');
  });

  it('qwen 没有档位的会话(导入的)也不裸跑:按编辑档 ⇒ default', () => {
    expect(argv('qwen', undefined)).toContain('--approval-mode=default');
  });

  it('cursor:Edit 落到只读(--mode ask),❌ 落进全权 agent 模式', () => {
    const args = argv('cursor', 'edit');
    expect(args.join(' ')).toContain('--mode ask');
    expect(args).not.toContain('-f');
  });

  it('完全访问恒原样 —— opencode 的完全访问由会话包兑现、不在档位表里,❌ 因此被降掉', () => {
    const modes = pluginRegistry.get('opencode')!.capabilities.autoApprove;
    expect(modes.kind === 'supported' && modes.modes?.['full-access']).toBeFalsy();
    expect(() => argv('opencode', 'full-access')).not.toThrow();
  });

  it('档位表不完整的家不经收档、字节照旧(#6231 逐家实测后再收):droid 只实测了完全访问、codex 没有规划档', () => {
    expect(() => argv('droid', 'edit')).not.toThrow();
    expect(() => argv('codex', 'plan')).not.toThrow();
  });

  it('不变量:真注册表里每一家档位表完整的 provider、每一档,解析结果都是声明过的档且不比所选更松', () => {
    const rung = (mode: GuguPermissionMode) => GUGU_PERMISSION_MODES.indexOf(mode);
    const mapped = pluginRegistry.getAll().flatMap((p) =>
      p.capabilities.autoApprove.kind === 'supported'
        && p.capabilities.autoApprove.modesExhaustive
        && p.capabilities.autoApprove.modes
        ? [{ id: p.metadata.id, modes: p.capabilities.autoApprove.modes }]
        : []);
    expect(mapped.map((p) => p.id)).toEqual(expect.arrayContaining(['qwen', 'cursor']));
    for (const { id, modes } of mapped) {
      for (const wanted of GUGU_PERMISSION_MODES) {
        const effective = resolveDeclaredPermissionMode(wanted, modes);
        if (effective === undefined) continue; // 由注册表响亮失败(index.test 的 #6221 用例)
        expect(effective === 'full-access' || Boolean(modes[effective]), `${id}/${wanted} → ${effective} 未声明`).toBe(true);
        expect(rung(effective), `${id}/${wanted} → ${effective} 更松`).toBeLessThanOrEqual(rung(wanted));
      }
    }
  });
});
