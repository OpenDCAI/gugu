import {
  LEGACY_PROJECT_CONFIG_FILE,
  PROJECT_CONFIG_FILE,
  type ProjectSettings,
  type ShareableProjectSettingsWriteField,
} from '@shared/core/project-settings/project-settings';
import { SHAREABLE_FIELD_ACCESSORS } from '@shared/core/project-settings/project-settings-fields';
import { parseJsonObject } from '../project-settings-json';

export const CONFIG_FILE = PROJECT_CONFIG_FILE;
/** 改名前的文件名,只在读取时兜底。 */
export const LEGACY_CONFIG_FILE = LEGACY_PROJECT_CONFIG_FILE;

export function parseWorkspaceConfigObject(raw: string): Record<string, unknown> {
  return parseJsonObject(raw) as Record<string, unknown>;
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = obj;
  for (const segment of path.slice(0, -1)) {
    const child = cursor[segment];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

export function patchShareableProjectSettingsFields(
  config: Record<string, unknown>,
  settings: ProjectSettings,
  fields: ShareableProjectSettingsWriteField[]
): ShareableProjectSettingsWriteField[] {
  const writtenFields: ShareableProjectSettingsWriteField[] = [];
  for (const field of fields) {
    const accessor = SHAREABLE_FIELD_ACCESSORS[field];
    const value = accessor.get(settings);
    if (value === undefined) continue;
    setNested(config, accessor.path, value);
    writtenFields.push(field);
  }
  return writtenFields;
}
