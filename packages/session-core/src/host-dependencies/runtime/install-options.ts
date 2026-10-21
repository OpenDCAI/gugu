import type { InstallOption, Platform } from '../capability';
import type { DependencyDescriptor } from './types';

/** Map Node.js `process.platform` to the session-core `Platform` type. */
export function toPlatform(p: NodeJS.Platform): Platform {
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

/**
 * Pick the best InstallOption from the descriptor's installCommands for the given platform.
 * With a method: returns the matching option (or undefined if not found).
 * With only a registry: returns that registry's option (or undefined if this platform has none).
 * With neither: returns the recommended option, or the first one.
 */
export function pickInstallOption(
  descriptor: DependencyDescriptor,
  platform: Platform,
  method?: string,
  registry?: string,
): InstallOption | undefined {
  const options = descriptor.installCommands?.[platform];
  if (!options || options.length === 0) return undefined;
  const matchesRegistry = (o: InstallOption) => registry === undefined || o.registry === registry;
  if (method) {
    return options.find((o) => o.method === method && matchesRegistry(o));
  }
  // 点名了下载源就必须拿那个源的那条命令 —— ❌ 不许退回「推荐的那条」:那样调用方以为自己
  // 选了 B、跑的却是 A,而它们的区别正是这次要换的东西(#6157 的换源重试就会原地重跑同一条)。
  // 点名的源在这个平台上没有对应选项时如实答不出来,由调用方决定下一步。
  if (registry !== undefined) return options.find(matchesRegistry);
  return options.find((o) => o.recommended) ?? options[0];
}

/**
 * Returns the per-platform InstallOption[] with the effective updateCommand filled in.
 * For package-manager strategy: updateCommand defaults to the install command.
 */
export function resolveInstallOptions(
  descriptor: DependencyDescriptor,
  platform: Platform,
): InstallOption[] {
  const options = descriptor.installCommands?.[platform] ?? [];
  const updates = descriptor.updates;

  if (!updates || updates.kind !== 'supported') return options;

  const strategy = updates.update;

  return options.map((opt) => {
    if (strategy.kind === 'package-manager') {
      return { ...opt, updateCommand: opt.updateCommand ?? opt.command };
    }
    return opt;
  });
}
