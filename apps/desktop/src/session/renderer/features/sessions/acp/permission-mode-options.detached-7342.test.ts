/**
 * #7342 停下了(没有活会话、也不在起):权限那一格照旧摆得出来 —— 按 provider 声明的映射表摆回四档,
 * 选中记录那一档。三张映射表逐字取自 各家 packages/session-plugins/src/agents/impl/<id>/permission-modes.ts
 * (桌面端解析不到那个子路径,所以抄过来;改那边时这里跟着改)。
 */
import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/client';
import { describe, expect, it } from 'vitest';
import {
  detachedPermissionModeOptions,
  localizePermissionModeOptions,
  selectedPermissionModeId,
} from './permission-mode-options';

const CODEX_PERMISSION_MODES = {
  'read-only': { id: ':read-only' },
  edit: { id: ':workspace' },
  'full-access': { id: ':danger-full-access' },
} satisfies ProviderPermissionModeMap;
const CLAUDE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'default', aliases: ['dontAsk'] },
  edit: { id: 'acceptEdits' },
  'full-access': { id: 'bypassPermissions' },
} satisfies ProviderPermissionModeMap;
const OPENCODE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  edit: { id: 'build' },
} satisfies ProviderPermissionModeMap;

const translate = (key: string) => key.replace('taskConfig.', '');

describe('detachedPermissionModeOptions (#7342)', () => {
  it('codex 记着完全访问:摆回它声明的三档,选中 `:danger-full-access`,危险档照活会话的判法标出来', () => {
    const detached = detachedPermissionModeOptions('full-access', CODEX_PERMISSION_MODES);
    expect(detached?.selected).toBe(':danger-full-access');
    expect(Object.keys(detached?.options ?? {})).toEqual([':read-only', ':workspace', ':danger-full-access']);
    expect(detached?.options[':danger-full-access']?.destructive).toBe(true);
    expect(detached?.options[':workspace']?.destructive).toBe(false);
    // 下游两步照常:收成四档改名,选中那一行就是它自己。
    const shown = localizePermissionModeOptions(detached!.options, translate as never, CODEX_PERMISSION_MODES);
    expect(shown?.[':danger-full-access']?.name).toBe('permissionFullAccess');
    expect(selectedPermissionModeId(detached!.selected, detached!.options, CODEX_PERMISSION_MODES)).toBe(':danger-full-access');
  });

  it('claude 记着编辑:选中 `acceptEdits`,四档都在', () => {
    const detached = detachedPermissionModeOptions('edit', CLAUDE_PERMISSION_MODES);
    expect(detached?.selected).toBe('acceptEdits');
    expect(Object.keys(detached?.options ?? {})).toEqual(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
  });

  it('说不出原生 id 就不摆:记录那一档这家没有(opencode 没有只读) / 没有映射表 / 没有档位', () => {
    expect(detachedPermissionModeOptions('read-only', OPENCODE_PERMISSION_MODES)).toBeNull();
    expect(detachedPermissionModeOptions('full-access', undefined)).toBeNull();
    expect(detachedPermissionModeOptions(null, CODEX_PERMISSION_MODES)).toBeNull();
  });
});
