import { useEffect, useState } from 'react'

/** 跟着咕咕的 [data-theme] 切明暗 —— 图表画在 canvas 上,吃不到 CSS 变量。 */
export function useChartTheme(): 'dark' | 'light' {
  const read = (): 'dark' | 'light' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** A gugu color token's current value for canvas marks (canvas cannot resolve CSS variables). Read it during render: a theme flip re-renders through useChartTheme. */
export function tokenColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
