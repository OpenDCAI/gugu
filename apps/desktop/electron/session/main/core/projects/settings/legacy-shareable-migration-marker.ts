import { log } from '@main/lib/logger';
import type { ShareableProjectSettings } from '@shared/core/project-settings/project-settings';
import { compactUndefined, parseJsonObject } from './project-settings-json';

const LEGACY_SHAREABLE_CONFIG_MIGRATED_AT = '__legacyShareableConfigMigratedAt';

function readLegacyShareableConfigMigratedAt(raw: string): string | undefined {
  try {
    const parsed = parseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[LEGACY_SHAREABLE_CONFIG_MIGRATED_AT];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export function hasLegacyShareableConfigMigrated(raw: string): boolean {
  return readLegacyShareableConfigMigratedAt(raw) !== undefined;
}

/**
 * gugu #2328: 在不重编码设置本体的前提下,把「legacy shareable 迁移已解决」标记写进原始 JSON。
 * 走 schema 再序列化会丢未知键;这里只加标记键,其余字节级保留。原始内容解析不出(坏 JSON /
 * 非对象)时不覆写——保留原始字节供人工抢救,响亮告警,收敛留到行被修复之后。
 */
export function markLegacyShareableConfigMigratedRaw(previousRaw: string): string {
  let parsed: Record<string, unknown>;
  try {
    const value = parseJsonObject(previousRaw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('shareable settings JSON is not an object');
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    log.warn(
      'legacy-shareable-migration: stored shareable settings unparseable — keeping raw bytes, skipping convergence marker',
      { error: String(error) }
    );
    return previousRaw;
  }
  parsed[LEGACY_SHAREABLE_CONFIG_MIGRATED_AT] = new Date().toISOString();
  return JSON.stringify(parsed);
}

export function serializeShareableProjectSettings(
  settings: ShareableProjectSettings,
  options: {
    previousRaw?: string;
    markLegacyShareableConfigMigrated?: boolean;
  } = {}
): string {
  const next = compactUndefined(settings) as Record<string, unknown>;
  const migratedAt = options.markLegacyShareableConfigMigrated
    ? new Date().toISOString()
    : options.previousRaw
      ? readLegacyShareableConfigMigratedAt(options.previousRaw)
      : undefined;

  if (migratedAt) {
    next[LEGACY_SHAREABLE_CONFIG_MIGRATED_AT] = migratedAt;
  }

  return JSON.stringify(next);
}
