import type { ExtensionManifest } from './manifest';

export type AppSettings = Record<string, string | boolean>;

/** Stored keys removed by an upgrade are ignored when reading, never accepted from a new write. */
export function resolveAppSettings(manifest: ExtensionManifest, input: unknown, stored = false): AppSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('App settings must be an object');
  const values = input as Record<string, unknown>;
  const fields = manifest.settings ?? [];
  if (!stored) {
    for (const key of Object.keys(values)) {
      if (!fields.some((field) => field.key === key)) throw new Error(`Unknown App setting: ${key}`);
    }
  }
  const result: AppSettings = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : field.default;
    if (value === undefined) continue;
    const valid = field.type === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'string' && value.length <= 4096 &&
        (field.type !== 'select' || field.options.some((option) => option.value === value));
    if (!valid) throw new Error(`Invalid value for App setting: ${field.title}`);
    result[field.key] = value as string | boolean;
  }
  return result;
}
