import { describe, expect, it } from 'vitest';
import {
  GUGU_PERMISSION_MODES,
  canRepresentPermissionMode,
  classifyProviderPermissionMode,
  type GuguPermissionMode,
} from '@gugu/session-core/acp';
import { pluginRegistry } from '../../registry';

/**
 * 聊天面板腿的档位契约:咕咕的每一档,在 zcode 自报的档位里落到**哪一个**原生档。
 *
 * 新起与恢复两条路都经 session-manager 的 `applyConfiguredPermissionMode` 用同一组函数
 * (`classifyProviderPermissionMode` + `canRepresentPermissionMode`,表完整时只认表)挑出目标档,
 * 再 `set_config_option(mode)` 显式下发;那两条路本身由 session-manager 的通用用例守。这里守的是
 * zcode 这一家的**表**:不加旗标 ≠ 任何一档,桥默认报 `yolo`,挑错档就是越权。
 *
 * 期望表**独立手抄**,出处是行为实测(2026-10-17,`@gugu-acp/zcode-acp` 1.0.0 + ZCode 3.15.3 /
 * CLI 0.16.9,glm-4.6;每档新起会话,同一句「写一个文件,再跑一条 Bash」,客户端一律答 reject_once):
 *   plan  → 只申请退出计划模式,文件没写、命令没跑
 *   build → Write 与 Bash 都先问(改东西前先问 = 只读,与 claude 的 default 同义)
 *   edit  → Write 直接执行,Bash 先问
 *   yolo  → 都不问,都执行
 * ❌ 不和 `ZCODE_PERMISSION_MODES` 共用一张表:共用时把只读接成 `guarded` 这种错会同时改掉期望,判据就打不红了。
 */
const EXPECTED: Record<GuguPermissionMode, string> = {
  plan: 'plan',
  'read-only': 'build',
  edit: 'edit',
  'full-access': 'yolo',
};

/** `session/new` 实测自报的五档(configOption `mode`),桥的默认当前档是 `yolo`。 */
const OFFERED = ['plan', 'build', 'edit', 'guarded', 'yolo'] as const;

describe('zcode 聊天面板腿的档位契约', () => {
  const autoApprove = pluginRegistry.get('zcode')!.capabilities.autoApprove;
  if (autoApprove.kind !== 'supported') throw new Error('zcode must declare autoApprove');
  const map = autoApprove.modes;
  const exhaustive = autoApprove.modesExhaustive === true;

  it('档位表是完整的:表外的原生档一档都不代表', () => {
    expect(exhaustive).toBe(true);
  });

  it.each(GUGU_PERMISSION_MODES.map((mode) => [mode]))('%s 落到实测的那一档', (mode) => {
    const representable = OFFERED.filter(
      (id) => classifyProviderPermissionMode(id, map) === mode && canRepresentPermissionMode(id, mode, map, exhaustive)
    );
    expect(representable).toEqual([EXPECTED[mode]]);
  });

  it('guarded 不代表咕咕的任何一档', () => {
    for (const mode of GUGU_PERMISSION_MODES) {
      expect(canRepresentPermissionMode('guarded', mode, map, exhaustive)).toBe(false);
    }
  });
});
