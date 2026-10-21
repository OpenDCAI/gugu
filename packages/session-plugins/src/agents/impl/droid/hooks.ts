import type { HookRegistration, PluginFs } from '@gugu/session-core/agents/plugins';
import {
  GUGU_HOOK_MARKER,
  buildNestedEntry,
  filterUserHooks,
  isJsonConfigParseError,
  makeStdinHookCommand,
  readJsonConfig,
  stripManagedJsonHooks,
  writeJsonConfig,
} from '@gugu/session-core/agents/plugins/helpers';

// `.factory/hooks.json` 无 gugu 归属标记 —— 没有出处证明是咕咕自建,归属存疑就按代价不对称往安全侧倒
// (误当用户文件顶多坏了不自愈,droid 新建当前不可达;误当咕咕文件会整份覆盖 = #4604)⇒ 'user'。
// `.factory/settings.json` = droid 的遗留用户设置文件,只当迁移来源,同样按用户文件处置(坏了保全不覆盖)。
export const DROID_HOOKS_PATH = '.factory/hooks.json';
const DROID_LEGACY_SETTINGS_PATH = '.factory/settings.json';
const DROID_HOOK_SPECS = [
  { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
  { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
  { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
  { hookKey: 'SessionStart', command: makeStdinHookCommand('session') },
];

function getHooks(config: Record<string, unknown>): Record<string, unknown[]> {
  return (config.hooks ?? {}) as Record<string, unknown[]>;
}

function mergeUniqueUserHooks(
  current: Record<string, unknown[]>,
  fallback: Record<string, unknown[]>
): Record<string, unknown[]> {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(fallback), ...Object.keys(current)])) {
    const currentEntries = Array.isArray(current[key]) ? current[key] : [];
    const fallbackEntries = Array.isArray(fallback[key]) ? fallback[key] : [];
    const entries = filterUserHooks([
      ...(fallbackEntries as Record<string, unknown>[]),
      ...(currentEntries as Record<string, unknown>[]),
    ]);
    const seen = new Set<string>();
    merged[key] = entries.filter((entry) => {
      const serialized = JSON.stringify(entry);
      if (seen.has(serialized)) return false;
      seen.add(serialized);
      return true;
    });
  }
  return merged;
}

function hasAllManagedEntries(hooks: Record<string, unknown[]>): boolean {
  return DROID_HOOK_SPECS.every(({ hookKey, command }) => {
    const entries = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
    const managedEntry = JSON.stringify(buildNestedEntry(command));
    return entries.some((entry) => JSON.stringify(entry) === managedEntry);
  });
}

// 遗留 `.factory/settings.json` 是**用户文件**且只是迁移来源:读它/清理它的解析失败都是尽力而为,
// ❌ 不许阻断主文件 hooks.json 的写(#4604 ③),也❌不许覆盖它(重犯 #4604 数据丢失)。只咽下
// 「配置语法错」这一类,别的错照旧上抛。
async function bestEffortLegacy<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isJsonConfigParseError(error)) throw error;
    return fallback;
  }
}

export function buildDroidHookConfig() {
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, DROID_HOOKS_PATH, 'user');
      return hasAllManagedEntries(getHooks(config))
        ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }]
        : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfig(fs, DROID_HOOKS_PATH, 'user');
      // 遗留读失败 → 跳过迁移(空 fallback),绝不因此挡住主文件。
      const legacyHooks = await bestEffortLegacy({}, async () =>
        getHooks(await readJsonConfig(fs, DROID_LEGACY_SETTINGS_PATH, 'user'))
      );
      const hooks = mergeUniqueUserHooks(getHooks(config), legacyHooks);

      for (const { hookKey, command } of DROID_HOOK_SPECS) {
        const existing = Array.isArray(hooks[hookKey]) ? hooks[hookKey] : [];
        hooks[hookKey] = [
          ...filterUserHooks(existing as Record<string, unknown>[]),
          buildNestedEntry(command),
        ];
      }

      // 主文件先落地 —— writtenPaths 在任何遗留清理之前就已确定,清理再失败也丢不掉它(#4604 ③)。
      await writeJsonConfig(fs, DROID_HOOKS_PATH, { ...config, hooks }, 'user');
      await bestEffortLegacy(undefined, () =>
        stripManagedJsonHooks(fs, DROID_LEGACY_SETTINGS_PATH, 'user')
      );
      return [DROID_HOOKS_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      await stripManagedJsonHooks(fs, DROID_HOOKS_PATH, 'user');
      await bestEffortLegacy(undefined, () =>
        stripManagedJsonHooks(fs, DROID_LEGACY_SETTINGS_PATH, 'user')
      );
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, DROID_HOOKS_PATH, 'user');
      return hasAllManagedEntries(getHooks(config));
    },
  };
}
