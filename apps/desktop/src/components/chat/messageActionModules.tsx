import { useEffect, useState, type ComponentProps } from 'react'

const loadQuickPicker = () => import('./EmojiQuickPicker')
const loadActionSheet = () => import('./MessageActionSheet')
const readyModules = new Map<() => Promise<unknown>, unknown>()

// Keep secondary surfaces out of the startup path without Suspense's cold reveal delay.
function useMessageActionModule<T>(load: () => Promise<T>) {
  const ready = readyModules.get(load) as T | undefined
  const [result, setResult] = useState<{ module: T } | { error: unknown }>()
  useEffect(() => {
    if (ready) return
    let mounted = true
    void load().then(
      (module) => { readyModules.set(load, module); if (mounted) setResult({ module }) },
      (error: unknown) => { if (mounted) setResult({ error }) },
    )
    return () => { mounted = false }
  }, [load, ready])
  if (result && 'error' in result) throw result.error
  return ready ?? result?.module
}

export function DeferredEmojiQuickPicker(props: ComponentProps<typeof import('./EmojiQuickPicker').EmojiQuickPicker>) {
  const module = useMessageActionModule(loadQuickPicker)
  return module ? <module.EmojiQuickPicker {...props} /> : null
}

export function DeferredMessageActionSheet(props: ComponentProps<typeof import('./MessageActionSheet').MessageActionSheet>) {
  const module = useMessageActionModule(loadActionSheet)
  return module ? <module.MessageActionSheet {...props} /> : null
}
