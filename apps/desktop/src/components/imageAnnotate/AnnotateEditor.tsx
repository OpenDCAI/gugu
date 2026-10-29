import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImageViewerItem } from '@/lib/imageViewer'
import { messageForUser } from '@/lib/userFacingError'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { annotateCaption, deleteShape, editShape, markersOf, newDocument } from './annotateModel'
import { annotationColors, exportAnnotation, loadAnnotationImage, renderBackground, renderVectors, type AnnotateColors } from './annotateRender'
import { useAnnotateCanvas } from './useAnnotateCanvas'
import { useAnnotateSend } from './useAnnotateSend'
import { AnnotateToolbar } from './AnnotateToolbar'
import { AnnotateNotes } from './AnnotateNotes'
import { AnnotateDoneMenu, AnnotateSendBar } from './AnnotateSendBar'
import { annotationItem } from './annotateSource'
import './annotate.css'

export default function AnnotateEditor({ item, mobile, onCancel, onDone }: { item: ImageViewerItem; mobile: boolean; onCancel: () => void; onDone: () => void }) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const [ready, setReady] = useState<{ image: HTMLImageElement; item: ImageViewerItem } | null>(null), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    setReady(null); setError(null)
    void Promise.all([loadAnnotationImage(item), annotationItem(item)]).then(([image, source]) => { if (!disposed) setReady({ image, item: source }) }, failure => { if (!disposed) setError(messageForUser(failure)) })
    return () => { disposed = true }
  }, [item, attempt])
  return ready ? <AnnotationCanvas item={ready.item} image={ready.image} mobile={mobile} onCancel={onCancel} onDone={onDone} />
    : <div className="ia-editor ia-loading" data-mobile={mobile || undefined}>
      <Button onClick={onCancel}>{t('cancel')}</Button>
      {error ? <><p role="alert">{error}</p><Button onClick={() => setAttempt(value => value + 1)}>{t('retry')}</Button></> : <p role="status">{t('loading')}</p>}
    </div>
}
function AnnotationCanvas({ item, image, mobile, onCancel, onDone }: {
  item: ImageViewerItem; image: HTMLImageElement; mobile: boolean; onCancel: () => void; onDone: () => void
}) {
  const { t } = useTranslation('main', { keyPrefix: 'imageAnnotate' })
  const editor = useAnnotateCanvas(newDocument(image.naturalWidth, image.naturalHeight))
  const root = useRef<HTMLDivElement>(null), background = useRef<HTMLCanvasElement>(null)
  const [colors, setColors] = useState<AnnotateColors | null>(null), [renderError, setRenderError] = useState<string | null>(null)
  useLayoutEffect(() => { if (root.current) { setColors(annotationColors(root.current)); root.current.focus() } }, [])
  const output = async () => {
    if (!colors) throw new Error(t('loading'))
    return exportAnnotation(image, editor.doc, colors)
  }
  const actions = useAnnotateSend(item, editor.doc, output, onDone)
  const { crop } = editor.doc
  const rasterKey = JSON.stringify([crop, editor.doc.shapes.filter(shape => shape.kind === 'mosaic')])
  useLayoutEffect(() => {
    if (!background.current) return
    try { renderBackground(background.current, image, editor.doc) }
    catch (failure) { setRenderError(messageForUser(failure)) }
    // Only raster operations invalidate the original bitmap; vector drags redraw the upper canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, rasterKey])
  useLayoutEffect(() => {
    if (!editor.vectors.current || !colors) return
    try { renderVectors(editor.vectors.current, editor.doc, colors, editor.hovered ?? editor.selected, editor.scale, editor.cropDraft) }
    catch (failure) { setRenderError(messageForUser(failure)) }
  }, [editor.doc, editor.selected, editor.hovered, editor.scale, editor.cropDraft, colors, editor.vectors])
  const textShape = editor.doc.shapes.find(shape => shape.id === editor.editingText && shape.kind === 'text')
  const notes = <AnnotateNotes markers={markersOf(editor.history.present)} selected={editor.selected} hovered={editor.hovered} noteFocus={editor.noteFocus}
    onHover={editor.setHovered} onSelect={editor.setSelected} mobile={mobile} disabled={actions.busy}
    onChange={(id, note) => editor.save(editShape(editor.history.present, id, shape => shape.kind === 'marker' ? { ...shape, note } : shape))}
    onDelete={id => { editor.save(deleteShape(editor.history.present, id)); editor.setSelected(null) }} />
  return <div ref={root} className="ia-editor" data-mobile={mobile || undefined} tabIndex={-1} aria-label={t('title')} aria-busy={actions.busy}
    onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}>
    <header className="ia-header"><Button onClick={onCancel} disabled={actions.busy}>{t('cancel')}</Button><h2>{t('title')}</h2><AnnotateDoneMenu actions={actions} mobile={mobile} /></header>
    {renderError ? <p role="alert" className="ia-error">{renderError}</p> : null}
    <div className="ia-workspace">
      <div ref={editor.stage} className="ia-stage" data-tool={editor.tool} onPointerDown={editor.onPointerDown} onPointerMove={editor.onPointerMove}
        onPointerUp={editor.onPointerUp} onPointerCancel={editor.onPointerCancel} onPointerLeave={() => editor.setHovered(null)}
        onDoubleClick={() => { if (editor.doc.shapes.some(shape => shape.id === editor.selected && shape.kind === 'text')) editor.setEditingText(editor.selected) }}>
        <div className="ia-plane" style={{ width: crop.width, height: crop.height, left: `calc(50% + ${editor.view.x}px)`, top: `calc(50% + ${editor.view.y}px)`, transform: `translate(-50%, -50%) scale(${editor.scale})` }}>
          <canvas ref={background} aria-hidden="true" />
          <canvas ref={editor.vectors} aria-label={t('canvas')} />
          {textShape?.kind === 'text' ? <Field.Root className="ia-text-editor" style={{ left: textShape.at.x - crop.x, top: textShape.at.y - crop.y, width: Math.max(160 / editor.scale, textShape.size * [...textShape.text].length), fontSize: textShape.size }}>
            <Field.Textarea autoFocus rows={2} aria-label={t('text')} value={textShape.text} disabled={actions.busy}
              onValueChange={value => editor.save(editShape(editor.doc, textShape.id, shape => shape.kind === 'text' ? { ...shape, text: value } : shape))}
              onBlur={editor.finishTextEdit} />
          </Field.Root> : null}
        </div>
      </div>
      {!mobile ? notes : null}
    </div>
    {mobile ? notes : null}
    <AnnotateToolbar editor={editor} />
    {!mobile ? <AnnotateSendBar actions={actions} /> : actions.error ? <p role="alert" className="ia-error">{actions.error}</p> : null}
    <p className="ia-hint">{t(mobile ? 'touchHint' : 'keyboardHint')}<span className="ia-sr-only">{annotateCaption(editor.doc, '', true)}</span></p>
  </div>
}
