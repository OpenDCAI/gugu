import {
  classifyProviderPermissionMode,
  GUGU_PERMISSION_MODES,
  type GuguPermissionMode,
  isDestructivePermissionMode,
  type ProviderPermissionModeMap,
} from '@gugu/session-core/acp/client';
import type { LiveSettingCapability } from '@gugu/session-core/agents/plugins';
import type { ComposerPermissionModeOption } from '@gugu/session-ui/react/components';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import type { SessionMessageValues } from '@renderer/localization/locale-store';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

type Options = Record<string, ComposerPermissionModeOption>;

/**
 * A provider-reported mode list does not imply that the running process can mutate it.
 * Hide the session selector when the provider explicitly declares no live permission channel;
 * creation-time controls remain governed by the separate `autoApprove` capability.
 */
export function sessionPermissionModeOptions(
  options: Options | null,
  liveSetting?: Pick<LiveSettingCapability, 'channel'> | null,
  sessionModes?: 'permission' | 'none',
): Options | null {
  if (sessionModes === 'none') return null;
  if (liveSetting?.channel === 'unsupported') return null;
  return options;
}

/**
 * #7342 停下了(没有活会话、也不在起):引擎报的那份原生档位清单跟着进程没了,用 provider 声明的
 * 映射表把四档摆回来(id 仍是原生 id,`localizePermissionModeOptions` 照常收成四档、改名),
 * 选中记录里那一档。危险档的判法与活会话那份逐字相同(`isDestructivePermissionMode`)。
 * 没有映射表、或记录那一档这家没有原生 id = 说不出,❌ 猜:不摆(同「没声明表就一个字都不动」)。
 */
export function detachedPermissionModeOptions(
  tier: GuguPermissionMode | null,
  modeMap: ProviderPermissionModeMap | undefined
): { options: Options; selected: string } | null {
  if (!tier || !modeMap) return null;
  const selected = modeMap[tier]?.id;
  if (!selected) return null;
  const options: Options = {};
  for (const rung of GUGU_PERMISSION_MODES) {
    const id = modeMap[rung]?.id;
    if (id) options[id] = { name: id, destructive: isDestructivePermissionMode(id) };
  }
  return { options, selected };
}

/** 该档在这个 agent 上真正能用的那个原生 id —— 声明的 id 优先,其次别名,都没上报就没有。 */
function reportedIdFor(
  rung: GuguPermissionMode,
  options: Options,
  modeMap: ProviderPermissionModeMap
): string | undefined {
  const entry = modeMap[rung];
  if (!entry) return undefined;
  return [entry.id, ...(entry.aliases ?? [])].find((candidate) => candidate in options);
}

/**
 * @@@permission-four-rungs — 会话页的档位下拉收敛成咕咕四档(规划/只读/编辑/完全访问)。
 *
 * agent 自报的原生档名是实现细节(codex 的 `:workspace`,claude 的 `acceptEdits`),
 * 此前原样摆进下拉,于是同一个概念在新建会话页叫「完全访问」、在会话页叫
 * "Agent Full Access"(现已收短为 "Full Access"),而且只有英文。
 *
 * ⚠️ 上一版按「这一档独一份才改名」做,结果是**中英混杂**:claude 报 6 档,
 * `default/plan/dontAsk` 都归只读、`auto/acceptEdits` 都归编辑,都不独一份于是留英文,
 * 只有 `bypassPermissions` 独占完全访问被改成中文 —— 5 英 1 中,比全英还糟。
 * 那个中间态是错的:要么全不改名,要么整个收成四档。owner 定的是收成档。
 *
 * 所以:**声明了映射表就只摆它声明过的那几档**(id 仍是原生 id,发下去照样认);
 * **没声明表就一个字都不动** —— 猜着改一半正是混杂的来源。
 *
 * ⚠️ 收敛的代价:同归一档的其余原生档(claude 的 `auto` / `dontAsk`)不再单列。
 */
export function localizePermissionModeOptions(
  options: Options | null,
  translate: Translate,
  modeMap?: ProviderPermissionModeMap
): Options | null {
  if (!options) return null;
  if (!modeMap) return options;

  const labels: Record<GuguPermissionMode, { name: string; description: string }> = {
    plan: {
      name: translate('taskConfig.permissionPlan'),
      description: translate('taskConfig.permissionPlanHint'),
    },
    'read-only': {
      name: translate('taskConfig.permissionReadOnly'),
      description: translate('taskConfig.permissionReadOnlyHint'),
    },
    edit: {
      name: translate('taskConfig.permissionEdit'),
      description: translate('taskConfig.permissionEditHint'),
    },
    'full-access': {
      name: translate('taskConfig.permissionFullAccess'),
      description: translate('taskConfig.permissionFullAccessHint'),
    },
  };

  const collapsed: Options = {};
  for (const rung of GUGU_PERMISSION_MODES) {
    const id = reportedIdFor(rung, options, modeMap);
    if (!id) continue;
    collapsed[id] = { ...options[id], ...labels[rung] };
  }

  // 表声明的档一个都没上报 = 这张表对不上这个 agent。别摆一个空下拉,原样交出去。
  if (Object.keys(collapsed).length === 0) return options;
  return collapsed;
}

/**
 * agent 当前处在的原生档,换算成收敛后下拉里那一行的 id。
 *
 * 没有这一步,agent 处在 `dontAsk` 时下拉会「什么都没选中」—— 明明在只读,界面却装作
 * 无状态。归类后指回本档的代表 id,界面显示「只读」,这才是它真实所处的档。
 */
export function selectedPermissionModeId(
  current: string | undefined,
  options: Options | null,
  modeMap?: ProviderPermissionModeMap
): string | undefined {
  if (!current || !options || !modeMap) return current;
  if (current in options && localizedIsCollapsedTo(current, options, modeMap)) return current;
  const rung = classifyProviderPermissionMode(current, modeMap);
  return reportedIdFor(rung, options, modeMap) ?? current;
}

function localizedIsCollapsedTo(
  id: string,
  options: Options,
  modeMap: ProviderPermissionModeMap
): boolean {
  const rung = classifyProviderPermissionMode(id, modeMap);
  return reportedIdFor(rung, options, modeMap) === id;
}
