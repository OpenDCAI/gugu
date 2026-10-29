import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from '@/lib/icons'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Field } from '../ui/Field'
import { Sheet } from '../ui/Sheet'
import { markerLabel, type Marker } from './annotateModel'

export function AnnotateNotes({ markers, selected, hovered, noteFocus, onHover, onSelect, onChange, onDelete, mobile, disabled }: {
  markers: readonly Marker[]; selected: string | null; onSelect: (id: string) => void
  hovered: string | null; noteFocus: number; onHover: (id: string | null) => void
  onChange: (id: string, note: string) => void; onDelete: (id: string) => void; mobile: boolean; disabled: boolean
}) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const [collapsed, setCollapsed] = useState(false), [opened, setOpened] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!markers.some(marker => marker.id === selected)) return
    setCollapsed(false)
    if (mobile) setOpened(selected)
    else root.current?.querySelector<HTMLInputElement>(`[data-marker-note="${selected}"]`)?.focus()
  }, [selected, mobile, markers.length, noteFocus])
  if (!markers.length) return null
  const noteField = (marker: Marker, index: number) => <div key={marker.id} className="ia-note-row" data-active={selected === marker.id || hovered === marker.id || undefined}
    onMouseEnter={() => onHover(marker.id)} onMouseLeave={() => onHover(null)}>
    <Field.Root>
      <Field.Label>{markerLabel(index)} {t('note')}</Field.Label>
      <Field.Input data-marker-note={marker.id} value={marker.note} autoFocus={mobile} placeholder={t('notePlaceholder')} disabled={disabled}
        onFocus={() => onSelect(marker.id)} onValueChange={value => onChange(marker.id, value)} />
    </Field.Root>
    <IconButton disabled={disabled} aria-label={t('deleteMarker', { number: index + 1 })} onClick={() => onDelete(marker.id)}><Trash2 /></IconButton>
  </div>
  if (mobile) {
    const current = markers.find(marker => marker.id === opened)
    return <div className="ia-note-chips">
      {markers.map((marker, index) => <Button key={marker.id} variant="ghost" disabled={disabled} aria-pressed={selected === marker.id}
        onClick={() => { onSelect(marker.id); setOpened(marker.id) }}>{markerLabel(index)} {marker.note || t('notePlaceholder')}</Button>)}
      {current ? <Sheet onClose={() => setOpened(null)} ariaLabel={t('notes')} mobileFitContent zIndex="var(--z-overlay)">
        <div className="ia-note-sheet">{noteField(current, markers.indexOf(current))}</div>
      </Sheet> : null}
    </div>
  }
  return <aside className="ia-notes" data-collapsed={collapsed || undefined} aria-label={t('notes')}>
    <Button variant="ghost" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{t('notes')} ({markers.length})</Button>
    {!collapsed ? <div ref={root}>{markers.map(noteField)}</div> : null}
  </aside>
}
