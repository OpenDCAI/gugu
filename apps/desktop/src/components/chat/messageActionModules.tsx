import { useEffect, useState, type ComponentProps } from 'react'

const loadQuickPicker = () => import('./EmojiQuickPicker')
const loadFullPicker = () => import('../EmojiPickerPanel')
const loadActionSheet = () => import('./MessageActionSheet')

// Keep secondary surfaces out of the startup path without Suspense's cold reveal delay.
function useMessageActionModule<T>(load: () => Promise<T>) {
  const [result, setResult] = useState<{ module: T } | { error: unknown }>()
  useEffect(() => {
    let mounted = true
    void load().then(
      (module) => { if (mounted) setResult({ module }) },
      (error: unknown) => { if (mounted) setResult({ error }) },
    )
    return () => { mounted = false }
  }, [load])
  if (result && 'error' in result) throw result.error
  return result?.module
}

export function DeferredEmojiQuickPicker(props: ComponentProps<typeof import('./EmojiQuickPicker').EmojiQuickPicker>) {
  const module = useMessageActionModule(loadQuickPicker)
  return module ? <module.EmojiQuickPicker {...props} /> : null
}

export function DeferredEmojiPickerPanel(props: ComponentProps<typeof import('../EmojiPickerPanel').EmojiPickerPanel>) {
  const module = useMessageActionModule(loadFullPicker)
  return module ? <module.EmojiPickerPanel {...props} /> : null
}

export function DeferredMessageActionSheet(props: ComponentProps<typeof import('./MessageActionSheet').MessageActionSheet>) {
  const module = useMessageActionModule(loadActionSheet)
  return module ? <module.MessageActionSheet {...props} /> : null
}
