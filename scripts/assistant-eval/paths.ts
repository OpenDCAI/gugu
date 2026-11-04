import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * `candidate` 落不落在 `root` 里(含 root 自己)。
 *
 * ⚠️ 判据必须按平台分隔符走:win32 上 `relative()` 回的是反斜杠,`${root}/` 那样的前缀比较永不命中 ——
 * 合法的工作区文件被判成「越界」抛出,落盘产物又会被静默跳过。`run.ts` 里同一条判据曾写死 `/`(#见
 * fixture 输入那条 Error)。
 */
export function insideRoot(root: string, candidate: string): boolean {
  const rest = relative(root, resolve(candidate))
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
}
