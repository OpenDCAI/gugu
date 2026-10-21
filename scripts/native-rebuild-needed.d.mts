export const NATIVE_REBUILD_INPUTS: RegExp[]
export const PACKAGE_JSON_NATIVE_FIELDS: string[]
export function pathNeedsNativeRebuild(file: string): boolean
export function packageJsonNativeFieldsChanged(beforeText: string, afterText: string): boolean
export function nativeRebuildNeeded(
  files: string[],
  options?: { readPackageJson?: () => [string, string] },
): { needed: boolean; reasons: string[] }
