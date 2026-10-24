import { useState } from 'react'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { PaneHeader } from '../ui/Pane'
import { Sheet } from '../ui/Sheet'
import { ChevronLeft } from '@/lib/icons'
import './contacts-letter-picker.css'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('')

/** A touch-sized index replaces 27 tiny hit targets, without changing contact ordering. */
export function ContactsLetterPicker({ present, onPick }: { present: Set<string>; onPick: (letter: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="lg" variant="secondary" className="gg-contacts-letter-trigger" aria-label="按首字母跳转" onClick={() => setOpen(true)}>A–Z</Button>
      {open && <Sheet onClose={() => setOpen(false)} ariaLabel="按首字母跳转" mobileFitContent>
        <div className="gg-contacts-letter-picker">
          <PaneHeader mobile title="按首字母跳转" titleLevel="panel" leading={<IconButton size="md" aria-label="返回联系人" onClick={() => setOpen(false)}><ChevronLeft /></IconButton>} />
          <div className="gg-contacts-letter-grid">
            {LETTERS.map((letter) => <Button key={letter} size="lg" variant="ghost" disabled={!present.has(letter)} onClick={() => { onPick(letter); setOpen(false) }}>{letter}</Button>)}
          </div>
        </div>
      </Sheet>}
    </>
  )
}
