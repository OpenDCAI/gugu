/** 把某个原生包**真的用起来**的动作。传进来的 require 从仓根解析,与产品加载它们的位置一致。 */
export type NativeExercise = (require: NodeJS.Require) => void

/** 包名 → exercise。判据只对登记在这里的包成立,覆盖对账见 discoverAbiFragilePackages。 */
export const NATIVE_PROBES: Record<string, NativeExercise>

export interface NativeProbeAttempt {
  name: string
  /** 这次 exercise 期间被 dlopen 的 .node 绝对路径 —— **尝试**就计数,打开失败也在内。 */
  loaded: string[]
  /** 非空表示 exercise 抛了,内容是错误信息首行。 */
  failure: string
}

export function probeNativeModules(input?: {
  repoRoot?: string
  probes?: Record<string, NativeExercise>
  log?: (line: string) => void
}): { bad: number; attempts: NativeProbeAttempt[] }

export function discoverAbiFragilePackages(repoRoot?: string): string[]

export function dropStaleBuilds(input?: {
  repoRoot?: string
  names?: string[]
  log?: (line: string) => void
}): string[]
