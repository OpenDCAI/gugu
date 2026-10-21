export const CACHE_ROOT: string
export function cacheBucket(root?: string): string
export function eslintArgs(args: string[], options: { bucketDir: string; noCache: boolean }): string[]
