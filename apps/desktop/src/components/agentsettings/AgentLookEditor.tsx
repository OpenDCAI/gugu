import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentStatusLabel } from '@gugu/core/shared/agentStatusPresentation'
import { Palette, Sparkles } from '@/lib/icons'
import { rendererLogger } from '../../lib/log'
import { agentStatusText } from '../../lib/agentStatusText'
import { useToast } from '../toastContext'
import { Button } from '../ui/Button'
import { AgentAvatar } from '../agentAvatar/AgentAvatar'
import { useAgentLookPostersVersion } from '../agentAvatar/posters'
import { wearKey } from '../agentAvatar/engine/outfitCatalog'
import { BODY_CHROMA, BODY_COLORS, BODY_LIGHTNESS, REST_FACES } from '../agentAvatar/engine/identity'
import type { ExpressionId } from '../agentAvatar/engine/spec'
import {
  BOLD_REST_FACES,
  colorSlug,
  rollLook,
  rollWear,
  sameLook,
  wornOf,
  type AgentLook,
} from '../agentAvatar/look'
import { AgentLookOutfits } from './AgentLookOutfits'
import { OUTFIT_DEFS } from '../agentAvatar/engine/outfitCatalog'
import './AgentLookPane.css'
import '../../i18n/registerAgentsCatalog'

const log = rendererLogger('agents/look')

/** 舞台上「试试状态」轮流演的几格(名字用全产品那一张状态词表)。null = 本体站着。 */
const TRY_STATES: readonly (AgentStatusLabel | null)[] = [null, 'running', 'needsApproval', 'done']
/** 掷骰子:每一跳的间隔(毫秒),越来越慢,最后一跳落在结果上。 */
const ROLL_STEPS = [55, 60, 70, 80, 95, 110, 130, 155, 185, 225]
const COLOR_COLUMNS = 4
const FACE_COLUMNS = 4

function cssColor(color: number): string {
  return `oklch(${BODY_LIGHTNESS} ${BODY_CHROMA} ${BODY_COLORS[color].hue})`
}

/** 每颗色球自己的颜色(CSS 变量,球的光泽由样式表按它算)。 */
function orbVars(color: number): CSSProperties {
  return { '--gg-orb': cssColor(color) } as CSSProperties
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** 骰子转动时的一跳:颜色、表情都换一个,和上一跳不同(装扮不动)。 */
function randomStep(prev: AgentLook): AgentLook {
  const colors = BODY_COLORS.map((_, i) => i).filter((i) => i !== prev.color)
  const faces = REST_FACES.filter((f) => f !== prev.rest)
  return {
    ...prev,
    color: colors[Math.floor(Math.random() * colors.length)],
    rest: faces[Math.floor(Math.random() * faces.length)],
  }
}

/** 方向键在一组单选格里挪(网格:左右 ±1、上下 ±列数),挪到哪格就选哪格并把焦点带过去。 */
function moveInGrid<T>(event: KeyboardEvent<HTMLElement>, items: readonly T[], index: number, columns: number, pick: (item: T) => void) {
  const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key]
  if (delta === undefined) return
  event.preventDefault()
  const next = Math.min(items.length - 1, Math.max(0, index + delta))
  pick(items[next])
  const group = event.currentTarget
  requestAnimationFrame(() => group.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus())
}

/**
 * 「形象」:给 agent 捏个样子 —— 身体颜色、休息表情、装扮三格。像游戏里的捏人:左边舞台上一只会动的小鸟,
 * 点哪格它就当场换上;骰子随机一只(颜色、表情、装扮,尽量不和主人的其它 agent 撞色、撞主件);「就它了」才写进库(形象地址存在头像字段,
 * 见 agentAvatar/look.ts),各端随之一起换。不是主人只能看。
 */
export function AgentLookEditor({
  id,
  name,
  number,
  current,
  hasSavedLook = false,
  usesPhoto = false,
  isOwned = true,
  onSave,
}: {
  id: string
  name: string
  number?: number | null
  current: AgentLook
  hasSavedLook?: boolean
  usesPhoto?: boolean
  isOwned?: boolean
  onSave: (look: AgentLook) => Promise<void>
}) {
  const { t } = useTranslation('agents')
  const { toast } = useToast()

  const [draft, setDraft] = useState<AgentLook>(current)
  const [tab, setTab] = useState<'color' | 'face' | 'outfit'>('color')
  const [tryIndex, setTryIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [celebrating, setCelebrating] = useState(false)
  const [pulse, setPulse] = useState(0)
  const [burst, setBurst] = useState(0)
  const [facePulse, setFacePulse] = useState<{ face: ExpressionId; n: number } | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useAgentLookPostersVersion() // 色球上「谁在用」那只小鸟的定格画好了就换上

  // 库里的形象变了(这里刚保存 / 别的设备改了 / 出生时定下来了):草稿没动过就跟着换,动过就留着。
  // 默认装扮(没有 wear)和明确不戴(wear=[])是两种存法,写法都是空串:分开记
  const savedKey = `${current.color}:${current.rest}:${current.wear === undefined ? '(default)' : wearKey(current.wear)}`
  const lastSaved = useRef(current)
  useEffect(() => {
    setDraft((d) => (sameLook(d, lastSaved.current) ? current : d))
    lastSaved.current = current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey])

  useEffect(() => () => {
    for (const id of timers.current) clearTimeout(id)
  }, [])

  const dirty = !sameLook(draft, current)
  const canSave = isOwned && !saving && !rolling && (dirty || !hasSavedLook)
  const editable = isOwned && !saving && !rolling
  const stageState = celebrating ? 'done' : TRY_STATES[tryIndex]
  const colorName = (color: number) => t(`settings.look.colors.${colorSlug(color)}`)
  const faceName = (face: ExpressionId) => t(`settings.look.faces.${face}`)

  function later(fn: () => void, ms: number) {
    timers.current.push(setTimeout(fn, ms))
  }

  function pick(next: AgentLook) {
    if (!editable) return
    setDraft(next)
    setPulse((n) => n + 1)
  }

  function roll() {
    if (!editable) return
    if (tab === 'outfit') {
      // 装扮页签里的骰子只换装扮:颜色、表情不动
      pick({ ...draft, wear: rollWear(draft.color, [], Math.random) })
      return
    }
    const final = rollLook([], draft, Math.random)
    if (prefersReducedMotion()) {
      setDraft(final)
      setPulse((n) => n + 1)
      return
    }
    setRolling(true)
    let at = 0
    // 转动的那几跳只换颜色、表情,装扮固定成此刻穿的那身
    let prev: AgentLook = { ...draft, wear: wornOf(draft) }
    ROLL_STEPS.forEach((step, i) => {
      at += step
      const last = i === ROLL_STEPS.length - 1
      const next = last ? final : randomStep(prev)
      prev = next
      later(() => {
        setDraft(next)
        if (!last) return
        setRolling(false)
        setPulse((n) => n + 1)
        setBurst((n) => n + 1)
      }, at)
    })
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(draft)
      toast(t('settings.look.saved'), 'success')
      setBurst((n) => n + 1)
      setCelebrating(true)
      later(() => setCelebrating(false), 2600)
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err) }, 'saving agent look failed')
      toast(t('settings.look.saveFailed'), 'error', messageForUser(err))
    } finally {
      setSaving(false)
    }
  }

  const lookVars = { '--gg-look-color': cssColor(draft.color) } as CSSProperties
  const tryLabel = agentStatusText(TRY_STATES[tryIndex] ?? 'idle')
  const colors = BODY_COLORS.map((_, i) => i)
  const colorIndex = colors.indexOf(draft.color)

  return (
    <div className="gg-look-wrap" data-testid="agent-look-pane">
      <div className="gg-look" style={lookVars}>
        <section className="gg-look-stage" aria-label={t('settings.look.stageLabel', { name: name })}>
          <div className="gg-look-dots" aria-hidden="true" />

          <div className="gg-look-stage-top">
            {number != null ? <span className="gg-look-tag">{t('settings.look.number', { n: number })}</span> : <span />}
            {dirty && isOwned ? <span className="gg-look-tag gg-look-tag--draft">{t('settings.look.unsaved')}</span> : null}
          </div>

          <div className="gg-look-scene">
            <div className="gg-look-glow" aria-hidden="true" />
            <span className="gg-look-twinkle gg-look-twinkle--a" aria-hidden="true"><SparkStar /></span>
            <span className="gg-look-twinkle gg-look-twinkle--b" aria-hidden="true"><SparkStar /></span>
            <span className="gg-look-twinkle gg-look-twinkle--c" aria-hidden="true"><SparkStar /></span>
            <div className="gg-look-podium" aria-hidden="true" />
            <div className="gg-look-hero">
              <AgentAvatar
                id={id}
                look={draft}
                holdExpression
                pulse={pulse}
                name={name}
                size={164}
                crop="full"
                state={stageState}
                interactive
                tracking
              />
              {burst > 0 ? (
                <span key={burst} className="gg-look-burst" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, i) => <span key={i} className="gg-look-ray" data-i={i}><SparkStar /></span>)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="gg-look-plate">
            <strong className="gg-look-plate-name">{name}</strong>
            <span className="gg-look-plate-sub">
              <span className="gg-look-plate-swatch" aria-hidden="true" />
              {t('settings.look.summary', { color: colorName(draft.color), face: faceName(draft.rest) })}
            </span>
          </div>

          {usesPhoto ? <p className="gg-look-note">{t('settings.look.photoNote')}</p> : null}

          <Button
            variant="ghost"
            className="gg-look-try"
            onClick={() => setTryIndex((i) => (i + 1) % TRY_STATES.length)}
            aria-label={t('settings.look.tryStateAria', { state: tryLabel })}
          >
            <span className="gg-look-try-play" aria-hidden="true" />
            <span className="gg-look-try-kicker">{t('settings.look.tryState')}</span>
            <span className="gg-look-try-state">{tryLabel}</span>
          </Button>
        </section>

        <section className="gg-look-panel">
          <header className="gg-look-head">
            <span className="gg-look-kicker"><Sparkles aria-hidden="true" size={14} />{t('settings.look.kicker')}</span>
            {!isOwned ? <span className="gg-look-readonly">{t('settings.look.notOwned')}</span> : null}
          </header>

          <div className="gg-look-tabs" role="tablist" aria-label={t('settings.look.kicker')}>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === 'color'}
              className="gg-look-tab"
              onClick={() => setTab('color')}
            >
              <Palette aria-hidden="true" size={16} />
              {t('settings.look.tabColor')}
              <span className="gg-look-tab-count">{BODY_COLORS.length}</span>
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === 'face'}
              className="gg-look-tab"
              onClick={() => setTab('face')}
            >
              <FaceIcon />
              {t('settings.look.tabFace')}
              <span className="gg-look-tab-count">{REST_FACES.length + BOLD_REST_FACES.length}</span>
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === 'outfit'}
              className="gg-look-tab"
              onClick={() => setTab('outfit')}
            >
              <HatIcon />
              {t('settings.look.tabOutfit')}
              <span className="gg-look-tab-count">{OUTFIT_DEFS.length}</span>
            </Button>
          </div>

          <div className="gg-look-scroll" role="tabpanel">
            {tab === 'color' ? (
              <>
                <div
                  className="gg-look-colors"
                  role="radiogroup"
                  aria-label={t('settings.look.tabColor')}
                  onKeyDown={(e) => moveInGrid(e, colors, colorIndex, COLOR_COLUMNS, (color) => pick({ ...draft, color }))}
                >
                  {colors.map((color) => {
                    const selected = color === draft.color
                    return (
                      <Button
                        key={color}
                        variant="ghost"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        disabled={!isOwned}
                        className="gg-look-cell gg-look-orb-cell"
                        data-color={colorSlug(color)}
                        title={colorName(color)}
                        onClick={() => pick({ ...draft, color })}
                        style={orbVars(color)}
                      >
                        <span className="gg-look-orb">
                          {selected ? <span className="gg-look-check" aria-hidden="true"><CheckMark /></span> : null}

                        </span>
                        <span className="gg-look-cell-label">{colorName(color)}</span>
                      </Button>
                    )
                  })}
                </div>
              </>
            ) : tab === 'face' ? (
              <>
                <FaceGroup
                  title={t('settings.look.facesDaily')}
                  faces={REST_FACES}
                  draft={draft}
                  worn={wornOf(draft)}
                  isOwned={isOwned}
                  faceName={faceName}
                  pulse={facePulse}
                  onHover={(face) => setFacePulse((p) => ({ face, n: (p?.n ?? 0) + 1 }))}
                  onPick={(rest) => pick({ ...draft, rest })}
                />
                <FaceGroup
                  title={t('settings.look.facesBold')}
                  faces={BOLD_REST_FACES}
                  draft={draft}
                  worn={wornOf(draft)}
                  isOwned={isOwned}
                  faceName={faceName}
                  pulse={facePulse}
                  onHover={(face) => setFacePulse((p) => ({ face, n: (p?.n ?? 0) + 1 }))}
                  onPick={(rest) => pick({ ...draft, rest })}
                />
              </>
            ) : (
              <AgentLookOutfits
                worn={wornOf(draft)}
                isDefault={draft.wear === undefined}
                editable={editable}
                onChange={(wear) => pick({ ...draft, wear })}
                onReset={() => pick({ color: draft.color, rest: draft.rest })}
              />
            )}
          </div>

          {isOwned ? (
            <footer className="gg-look-foot">
              <Button
                variant="secondary"
                className="gg-look-dice"
                data-rolling={rolling || undefined}
                disabled={saving}
                onClick={roll}
                aria-label={t(tab === 'outfit' ? 'settings.look.rollOutfitAria' : 'settings.look.rollAria')}
              >
                <DiceIcon />
                {t('settings.look.roll')}
              </Button>
              <span className="gg-look-foot-gap" />
              {dirty ? (
                <Button variant="ghost" disabled={!editable} onClick={() => pick(current)}>
                  {t('settings.look.revert')}
                </Button>
              ) : null}
              <Button variant="primary" className="gg-look-save" disabled={!canSave} onClick={() => void save()}>
                {saving ? t('settings.look.saving') : canSave ? t('settings.look.save') : t('settings.look.current')}
              </Button>
            </footer>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function FaceGroup({
  title,
  faces,
  draft,
  worn,
  isOwned,
  faceName,
  pulse,
  onHover,
  onPick,
}: {
  title: string
  faces: readonly ExpressionId[]
  draft: AgentLook
  /** 舞台上那只此刻穿的那一身:样片穿同一身,只换脸 */
  worn: AgentLook['wear']
  isOwned: boolean
  faceName: (face: ExpressionId) => string
  pulse: { face: ExpressionId; n: number } | null
  onHover: (face: ExpressionId) => void
  onPick: (face: ExpressionId) => void
}) {
  const index = faces.indexOf(draft.rest)
  return (
    <div className="gg-look-face-group">
      <div className="gg-look-group-head">
        <span className="gg-look-group-title">{title}</span>
      </div>
      <div
        className="gg-look-faces"
        role="radiogroup"
        aria-label={title}
        onKeyDown={(e) => moveInGrid(e, faces, Math.max(0, index), FACE_COLUMNS, onPick)}
      >
        {faces.map((face, i) => {
          const selected = face === draft.rest
          return (
            <Button
              key={face}
              variant="ghost"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (index < 0 && i === 0) ? 0 : -1}
              disabled={!isOwned}
              className="gg-look-cell gg-look-face-cell"
              data-face={face}
              onClick={() => onPick(face)}
              onMouseEnter={() => onHover(face)}
            >
              <span className="gg-look-face">
                <AgentAvatar
                  id={`look-face-${face}`}
                  look={{ color: draft.color, rest: face, wear: worn }}
                  holdExpression
                  pulse={pulse?.face === face ? pulse.n : undefined}
                  name={faceName(face)}
                  size={46}
                  crop="bust"
                  fx={false}
                  tracking={false}
                />
                {selected ? <span className="gg-look-check" aria-hidden="true"><CheckMark /></span> : null}
              </span>
              <span className="gg-look-cell-label">{faceName(face)}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function SparkStar() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <path fill="currentColor" d="M12 0C12.9 6.3 17.7 11.1 24 12C17.7 12.9 12.9 17.7 12 24C11.1 17.7 6.3 12.9 0 12C6.3 11.1 11.1 6.3 12 0Z" />
    </svg>
  )
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="m6 12.5 4 4 8-9" />
    </svg>
  )
}

function DiceIcon() {
  return (
    <svg className="gg-look-dice-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function HatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M6.5 15.5c0-4.5 2.5-8 5.5-8s5.5 3.5 5.5 8" />
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3.5 16.5c2.4 1.3 5.3 2 8.5 2s6.1-.7 8.5-2" />
      <circle cx="12" cy="5.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function FaceIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <ellipse cx="9" cy="10.5" rx="1" ry="1.5" fill="currentColor" />
      <ellipse cx="15" cy="10.5" rx="1" ry="1.5" fill="currentColor" />
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M9 15.5c.85.63 1.885 1 3 1s2.15-.37 3-1" />
    </svg>
  )
}
