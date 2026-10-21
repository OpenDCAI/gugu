// @@@3922 给 .mjs 扫描器一份声明 —— 判据用 TS 写,不给声明就是 implicit any(仓库先例:
// apps/desktop/electron/runtime/codex-model-catalog.d.mts)。
export declare const HOOKS_DIR: string
/** 扫出「收主体参数且返回值」的 renderer hook,形如 `<相对路径>::<hook 名>`,已排序。 */
export declare function scanSubjectScopedHooks(root?: string): string[]
