export const STAMP: string
export function nodeModulesDirs(root: string): string[]
export function beforeInstall(root: string): { cleared: string[] }
export function afterInstall(root: string): void
