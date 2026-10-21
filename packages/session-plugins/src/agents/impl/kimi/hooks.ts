import type { PluginFs } from '@gugu/session-core/agents/plugins';
import type { HookRegistration } from '@gugu/session-core/agents/plugins';
import {
  GUGU_HOOK_MARKER,
  filterUserHooks,
  makeStdinHookCommand,
} from '@gugu/session-core/agents/plugins/helpers';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';

export const KIMI_CONFIG_PATH = '.kimi-code/config.toml';
export const KIMI_LEGACY_CONFIG_PATH = '.kimi/config.toml';

const KIMI_HOOK_SPECS = [
  { hookKey: 'SessionStart', command: makeStdinHookCommand('session') },
  { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
  { hookKey: 'PostToolUse', command: makeStdinHookCommand('start') },
  { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('start') },
  { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
  { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
  { hookKey: 'StopFailure', command: makeStdinHookCommand('stop') },
  { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop') },
];

function buildKimiHookEntries(existing: unknown[]): unknown[] {
  const userEntries = filterUserHooks(existing as Record<string, unknown>[]);
  const emdashEntries = KIMI_HOOK_SPECS.map(({ hookKey, command }) => ({
    event: hookKey,
    command,
  }));
  return [...userEntries, ...emdashEntries];
}

/**
 * @param onlyIfExists 文件不在就**什么都不做**(而不是新建一份)。
 *
 * ⚠️ 给旧版路径 `.kimi/config.toml` 用。无条件写会**凭空造出一个「旧版 kimi-cli 安装」**——
 * owner 2026-08-28 实测:咕咕的独立 home 里本来只有 `.kimi-code/`,写完之后多出一个
 * 只装着咕咕 hooks 的 `.kimi/config.toml`,kimi-code 一启动就弹
 * 「Found an existing kimi-cli installation … Migrate this data to kimi-code?」——
 * 让用户去迁移一份**咕咕自己刚造出来的**东西。
 * (在用户真 home 上它同样是残留,只是那儿多半本来就有 `~/.kimi`,症状被盖住了。)
 */
async function writeKimiHookPath(
  fs: PluginFs,
  path: string,
  onlyIfExists = false
): Promise<boolean> {
  const content = await fs.read(path);
  if (onlyIfExists && !content) return false;
  let config: Record<string, unknown> = {};
  if (content) {
    try {
      config = parseTOML(content) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const hooks = Array.isArray(config.hooks) ? config.hooks : [];
  config.hooks = buildKimiHookEntries(hooks);
  await fs.write(path, stringifyTOML(config));
  return true;
}

export function buildKimiHookConfig() {
  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      for (const path of [KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH]) {
        const content = await fs.read(path);
        if (!content) continue;
        try {
          const config = parseTOML(content) as Record<string, unknown>;
          const hooks = Array.isArray(config.hooks) ? config.hooks : [];
          if (hooks.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER))) {
            return [{ event: 'gugu', command: GUGU_HOOK_MARKER }];
          }
        } catch {
          /* skip */
        }
      }
      return [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      await writeKimiHookPath(fs, KIMI_CONFIG_PATH);
      // ⚠️ 旧版路径**只更新、不创建**(理由见 `writeKimiHookPath` 的 `onlyIfExists`):
      //    创建它 = 无中生有一个「旧版 kimi-cli 安装」,引擎会请用户去迁移它。
      const legacy = await writeKimiHookPath(fs, KIMI_LEGACY_CONFIG_PATH, true);
      // 返回**真写过的**那些 —— 这份清单会进 .gitignore / 残留清扫,
      // 报一个根本不存在的文件会让清扫器去删一个它造不出来的东西。
      return legacy ? [KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH] : [KIMI_CONFIG_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      for (const path of [KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH]) {
        const content = await fs.read(path);
        if (!content) continue;
        try {
          const config = parseTOML(content) as Record<string, unknown>;
          if (Array.isArray(config.hooks)) {
            config.hooks = filterUserHooks(config.hooks as Record<string, unknown>[]);
          }
          await fs.write(path, stringifyTOML(config));
        } catch {
          /* skip */
        }
      }
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      for (const path of [KIMI_CONFIG_PATH, KIMI_LEGACY_CONFIG_PATH]) {
        const content = await fs.read(path);
        if (!content) continue;
        try {
          const config = parseTOML(content) as Record<string, unknown>;
          const hooks = Array.isArray(config.hooks) ? config.hooks : [];
          if (hooks.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER))) return true;
        } catch {
          /* skip */
        }
      }
      return false;
    },
  };
}
