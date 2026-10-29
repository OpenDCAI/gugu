export declare const NATIVE_EXTERNAL_PACKAGES: readonly string[]
export declare const ADAPTER_BRIDGE_ENTRIES: readonly string[]
export declare const ADAPTER_PACKAGES: readonly string[]
export declare const BROWSER_PACKAGES: readonly string[]
export declare const APP_ROOT_PACKAGE_FILES: readonly string[]
export declare const RUNTIME_PACKAGES: readonly string[]
export declare const EXCLUDED_NATIVE_PACKAGE_PREFIXES: readonly string[]
export declare function packageNameOf(specifier: string): string
export declare function runtimeResolvedSpecifiers(source: string): Set<string>
export declare function assertRuntimeSpecifiersResolve(appDir: string): string[]
export interface PatchedDependency {
  name: string
  version: string
  patch: string
}
export declare function parsePatchedDependencies(yamlText: string): PatchedDependency[]
export declare function isExcludedNativePackage(name: string): boolean
export declare function externalDependencySpec(
  name: string,
  rootDependencies: Record<string, string> | undefined,
  installedVersion: string,
): string
