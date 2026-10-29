import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Eraser, Hash, PenLine, Scissors, Square, TextCursorInput, Undo2 } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import type { AnnotateColor, AnnotateTool } from './annotateModel'
import type { useAnnotateCanvas } from './useAnnotateCanvas'

const tools = [
  ['rect', 'R', Square], ['arrow', 'A', ArrowUpRight], ['marker', 'N', Hash], ['pen', 'P', PenLine],
  ['text', 'T', TextCursorInput], ['mosaic', 'M', Eraser], ['crop', 'C', Scissors],
] as const
export function AnnotateToolbar({ editor }: { editor: ReturnType<typeof useAnnotateCanvas> }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  return <div className="ia-toolbar" aria-label={t('tools')}>
    <div className="ia-tools" role="toolbar" aria-label={t('tools')}>
      {tools.map(([tool, key, Icon]) => <IconButton key={tool} aria-label={t(tool)} title={`${t(tool)} (${key})`} aria-pressed={editor.tool === tool}
        onClick={() => editor.chooseTool(tool as AnnotateTool)}><Icon /></IconButton>)}
    </div>
    <div className="ia-style-tools">
      <div className="ia-colors" role="group" aria-label={t('color')}>
        {(['danger', 'warn', 'live', 'ok', 'white'] as AnnotateColor[]).map(color => <IconButton key={color} aria-label={t(`colors.${color}`)} aria-pressed={editor.color === color}
          onClick={() => editor.setStyle({ color })}><span className="ia-color" style={{ background: color === 'white' ? 'var(--color-white)' : `var(--${color})` }} /></IconButton>)}
      </div>
      <div className="ia-widths" role="group" aria-label={t('lineWidth')}>
        {[3, 5, 8].map(width => <Button key={width} size="sm" variant="ghost" aria-pressed={editor.lineWidth === width} onClick={() => editor.setStyle({ lineWidth: width })}>{width}</Button>)}
      </div>
      <IconButton aria-label={t('undo')} title={`${t('undo')} (⌘Z)`} disabled={!editor.history.past.length} onClick={editor.undoEdit}><Undo2 /></IconButton>
      <IconButton aria-label={t('redo')} title={`${t('redo')} (⇧⌘Z)`} disabled={!editor.history.future.length} onClick={editor.redoEdit}><Undo2 style={{ transform: 'scaleX(-1)' }} /></IconButton>
    </div>
  </div>
}
