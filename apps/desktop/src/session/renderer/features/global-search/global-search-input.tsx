import { useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'

/** A text field whose Enter never fires while an IME is composing (#213), including engines that only send keyCode 229. */
export function GlobalSearchInput({ value, onValueChange, onSubmit, onKeyDown, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'onSubmit'> & {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
}) {
  const [composition, setComposition] = useState<string | null>(null)
  const composing = useRef(false)
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onSubmit(); return }
    onKeyDown?.(event)
  }
  return <input {...rest} value={composition ?? value}
    onCompositionStart={(event) => { composing.current = true; setComposition(event.currentTarget.value) }}
    onCompositionEnd={(event) => { composing.current = false; setComposition(null); onValueChange(event.currentTarget.value) }}
    onChange={(event) => { if (composing.current) setComposition(event.currentTarget.value); else onValueChange(event.currentTarget.value) }}
    onKeyDown={keydown} />
}
