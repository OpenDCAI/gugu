import { useLayoutEffect, type ReactNode } from 'react'
import { commitStartupContent } from '@/lib/startup-motion'

export function StartupMotionBoundary({ children }: { children: ReactNode }) {
  useLayoutEffect(commitStartupContent, [])
  return children
}
