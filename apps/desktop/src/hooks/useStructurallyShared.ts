import { useRef } from 'react'
import { replaceEqualDeep } from '@tanstack/react-query'

/**
 * 值相等就沿用上一次的引用(逐层结构共享:只有真变了的那一支换新对象)。
 * 用在「每次都重新拼、内容却多半没变」的派生值上 —— 否则下游 memo 组件每次都被一个新引用打穿。
 */
export function useStructurallyShared<T>(next: T): T {
  const shared = useRef(next)
  shared.current = replaceEqualDeep(shared.current, next)
  return shared.current
}
