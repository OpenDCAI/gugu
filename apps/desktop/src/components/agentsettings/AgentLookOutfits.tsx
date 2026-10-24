import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { OUTFIT_BY_ID, OUTFIT_DEFS, SLOT_ORDER, putOn, recolor, type Slot, type WearItem } from '../agentAvatar/engine/outfitCatalog'

/** 配色圆点自己的颜色(CSS 变量,圆点由样式表画) */
function swatchVars(swatch: string): CSSProperties {
  return { '--gg-swatch': swatch } as CSSProperties
}

/**
 * 形象工坊的「装扮」页签(玩家 DIY):按位置一排排列出全部装扮,点一件就穿上(同位置的、和它打架的自动摘下,并说一句摘了什么),
 * 穿着的那件下面出它的配色圆点;「全部摘掉」= 明确不戴,「恢复默认」= 回到不戴装扮(形象地址里去掉 wear)。
 * 墨镜、披风、背包、滑板、雨伞这些不进随机的,只在这里能搭。
 */
export function AgentLookOutfits({
  worn,
  isDefault,
  editable,
  onChange,
  onReset,
}: {
  /** 舞台上那只此刻穿的那一身(look.ts wornOf) */
  worn: readonly WearItem[]
  /** 草稿里没有 wear:使用不戴装扮的默认形象 */
  isDefault: boolean
  editable: boolean
  onChange: (wear: WearItem[]) => void
  onReset: () => void
}) {
  const { t } = useTranslation('agents')
  const [note, setNote] = useState<string | null>(null)
  const name = (id: string) => t(`settings.look.outfits.${id}`)

  function wear(id: string) {
    if (!editable) return
    const { wear: next, removed } = putOn(worn, id)
    setNote(removed.length ? t('settings.look.outfitClash', { on: name(id), off: removed.map(name).join('、') }) : null)
    onChange(next)
  }

  function bare(slot: Slot) {
    if (!editable) return
    setNote(null)
    onChange(worn.filter((w) => OUTFIT_BY_ID.get(w.id)!.slot !== slot))
  }

  return (
    <div className="gg-look-outfits">
      <p className="gg-look-outfit-note" aria-live="polite">
        {note ?? (isDefault ? t('settings.look.outfitDefaultNote') : worn.length === 0 ? t('settings.look.outfitNoneNote') : '')}
      </p>
      {SLOT_ORDER.map((slot) => {
        const defs = OUTFIT_DEFS.filter((d) => d.slot === slot)
        const on = worn.find((w) => OUTFIT_BY_ID.get(w.id)!.slot === slot)
        const onDef = on ? OUTFIT_BY_ID.get(on.id)! : null
        return (
          <div key={slot} className="gg-look-outfit-group" data-slot={slot}>
            <div className="gg-look-group-head">
              <span className="gg-look-group-title">{t(`settings.look.outfitSlots.${slot}`)}</span>
            </div>
            <div className="gg-look-chips" role="radiogroup" aria-label={t(`settings.look.outfitSlots.${slot}`)}>
              <Button
                variant="ghost"
                role="radio"
                aria-checked={!on}
                disabled={!editable}
                className="gg-look-chip"
                data-outfit=""
                onClick={() => bare(slot)}
              >
                {t('settings.look.outfitNone')}
              </Button>
              {defs.map((d) => (
                <Button
                  key={d.id}
                  variant="ghost"
                  role="radio"
                  aria-checked={on?.id === d.id}
                  disabled={!editable}
                  className="gg-look-chip"
                  data-outfit={d.id}
                  onClick={() => (on?.id === d.id ? undefined : wear(d.id))}
                >
                  {name(d.id)}
                </Button>
              ))}
            </div>
            {on && onDef && onDef.colorways.length > 1 ? (
              <div className="gg-look-swatches" role="radiogroup" aria-label={name(on.id)}>
                {onDef.colorways.map((cw, i) => (
                  <Button
                    key={i}
                    variant="ghost"
                    role="radio"
                    aria-checked={on.cw === i}
                    aria-label={t('settings.look.outfitColorway', { n: i + 1 })}
                    disabled={!editable}
                    className="gg-look-swatch"
                    data-colorway={i}
                    style={swatchVars(cw.swatch)}
                    onClick={() => editable && onChange(recolor(worn, on.id, i))}
                  >
                    <span className="gg-look-swatch-dot" aria-hidden="true" />
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      <p className="gg-look-hint">{t('settings.look.outfitHint')}</p>
      {editable ? (
        <div className="gg-look-outfit-actions">
          <Button variant="ghost" size="sm" disabled={worn.length === 0 && !isDefault} onClick={() => { setNote(null); onChange([]) }}>
            {t('settings.look.outfitClear')}
          </Button>
          {!isDefault ? (
            <Button variant="ghost" size="sm" onClick={() => { setNote(null); onReset() }}>
              {t('settings.look.outfitDefault')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
