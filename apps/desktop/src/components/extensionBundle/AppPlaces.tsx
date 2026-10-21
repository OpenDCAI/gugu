import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import '../../i18n/registerMessagingCatalog'
import { Folder, Monitor, Plus, X } from '@/lib/icons'
import { HERE_ALL, type EnablePlace } from '../../session/shared/extensions/host-actions'
import type { PlaceChange } from '../../session/shared/extensions/app-places'
import { useMobileShell } from '../../hooks/useMobileShell'
import { Avatar, type AvatarProps } from '../Avatar'
import { ChatPickSheet, type ChatPickRow } from '../chat/ChatPickSheet'
import { highlightText } from '../chat/highlightText'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'

/** This computer's two places, each drawn by its icon. */

/** An agent as the chat list draws it (its own face); a group by its picture, else its members' faces. */
const placeAvatar = (place: EnablePlace): AvatarProps =>
  place.kind === 'agent'
    ? { name: place.name ?? '', avatarUrl: place.avatar ?? null, seed: place.agentId ?? place.id, isAgent: true }
    : { name: place.name ?? '', avatarUrl: place.avatar ?? null, seed: place.id, variant: 'group', memberAvatars: place.members ?? [] }

const CAPTION = 'flex items-center gap-1 px-1 pt-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]'
const BOX = 'flex flex-col gap-px rounded-[var(--radius-document)] border border-[var(--border-color)] bg-[var(--modal-bg)] p-1'
const QUIET = 'text-[length:var(--font-caption)] leading-normal text-[var(--text-tertiary)]'
const TILE = 'flex shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-secondary)]'

function Chip({ children, mark }: { children: ReactNode; mark: string }) {
  return (
    <span className="gg-chip" data-place-mark={mark}>
      {children}
    </span>
  )
}

/** The marks after a place's name: 「你的 agent」, 「项目」, 「卡片所在」. */
function PlaceMarks({ place }: { place: EnablePlace }) {
  const { t } = useTranslation('messaging')
  return (
    <>
      {place.kind === 'agent' ? <Chip mark="agent">{t('chatArea.appEnable.agent')}</Chip> : null}
      {place.project ? <Chip mark="project"><Folder size={11} />{t('chatArea.appEnable.project')}</Chip> : null}
      {place.card ? <Chip mark="card">{t('chatArea.appEnable.cardGroup')}</Chip> : null}
    </>
  )
}

/** One place in the editor: its picture, its name with its marks, a line more, and what it does on the right. */
function PlaceRow(props: { id: string; mobile: boolean; leading: ReactNode; title?: string; marks?: ReactNode; sub?: string; children: ReactNode }) {
  return (
    <div className="gg-list-row cursor-default" data-mobile={props.mobile || undefined} data-place-row={props.id}>
      <div className="gg-list-row-leading">{props.leading}</div>
      <div className="gg-list-row-body">
        <div className="gg-list-row-line"><span className="gg-list-row-title">{props.title}</span>{props.marks}</div>
        {props.sub ? <div className="gg-list-row-line"><span className="gg-list-row-subtitle">{props.sub}</span></div> : null}
      </div>
      {props.children}
    </div>
  )
}

/**
 * D-30 「给哪些 agent」 (主人 10-02 方案 A, 10-06「肯定是能选的啊」): one editor for an install's consent sheet (desktop and
 * phone) and an App's row in 「App」. This computer's agents are one switch: every agent. Then what is chosen besides — the person's own
 * agents, by face and name, and groups as the chat list draws them — each with its ×, and 「添加 agent、群或项目…」 opening the
 * picker. Asked only about an App that gives agents tools (125 10-05).
 */
export function AppPlacesEditor({ places, machineName, enabled, onChange, installing = false, disabled = false }: {
  places: readonly EnablePlace[]
  /** D-31 Asked from another device: the computer whose agents these are, named instead of 「这台电脑」. */
  machineName?: string
  enabled: ReadonlySet<string>
  onChange: (changes: readonly PlaceChange[]) => void
  /** In the install's sheet: choosing none is fine, it can be done later. */
  installing?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const [picking, setPicking] = useState(false)
  const size = mobile ? 40 : 32
  const tileSize = mobile ? 'size-10' : 'size-8'
  const others = places.filter((place) => place.kind !== 'here')
  const chosen = others.filter((place) => enabled.has(place.id))
  const all = enabled.has(HERE_ALL)
  // This computer's agents are places only where main listed them (the desktop): a phone has no agents to switch.
  const asksMachine = places.some((place) => place.kind === 'here')
  return (
    <div className="flex flex-col gap-1" data-testid="app-places">
      {asksMachine ? (
        <>
          <div className={CAPTION}>{machineName ?? t('chatArea.appEnable.machine')}</div>
          <div className={BOX}>
            <PlaceRow id={HERE_ALL} mobile={mobile} leading={<span className={`${TILE} ${tileSize} bg-[var(--muted)]`}><Monitor size={size / 2} /></span>} title={t('chatArea.appEnable.all')} sub={t('chatArea.appEnable.allSub')}>
              <Switch checked={all} disabled={disabled} aria-label={t('chatArea.appEnable.all')} data-place-switch={HERE_ALL} onCheckedChange={(next) => onChange([{ id: HERE_ALL, on: next }])} />
            </PlaceRow>
          </div>
        </>
      ) : null}
      <div className={CAPTION}>{t('chatArea.appEnable.chosen', { count: chosen.length })}</div>
      <div className={BOX}>
        {/* 「还没选」只在真的谁都没给时说:本机所有 agent 开着时,下面没有别的地方不等于没给(148 评审,编号 2)。 */}
        {chosen.length === 0 && !all ? (
          <div className={`${QUIET} px-3 pb-1 pt-3`}>{t(installing ? 'chatArea.appEnable.emptyInstall' : 'chatArea.appEnable.empty')}</div>
        ) : null}
        {chosen.map((place) => (
          <PlaceRow key={place.id} id={place.id} mobile={mobile} leading={<Avatar size={size} {...placeAvatar(place)} />} title={place.name}
            marks={<PlaceMarks place={place} />}>
            {place.kind === 'group' ? <span className="gg-list-row-meta">{t('chatArea.appEnable.members', { count: place.memberCount ?? 0 })}</span> : null}
            <IconButton size={mobile ? 'lg' : 'sm'} disabled={disabled} data-place-remove={place.id} aria-label={t('chatArea.appEnable.remove', { name: place.name })} onClick={() => onChange([{ id: place.id, on: false }])}>
              <X />
            </IconButton>
          </PlaceRow>
        ))}
        <Button variant="ghost" size="option" className="gg-list-row gap-[var(--row-gap)]" data-testid="app-places-add" disabled={disabled} onClick={() => setPicking(true)}>
          <span className={`${TILE} ${tileSize} border-[1.5px] border-dashed border-[var(--border-strong)]`}>
            <Plus size={Math.round(size * 0.45)} />
          </span>
          <span className="gg-list-row-title font-[var(--font-weight-medium)] text-[var(--text-secondary)]">{t('chatArea.appEnable.add')}</span>
        </Button>
      </div>
      <div className={`${QUIET} px-1 pt-1`}>{t('chatArea.appEnable.hint')}</div>
      {picking ? (
        <AppPlacesPicker
          places={others}
          chosen={new Set(chosen.map((place) => place.id))}
          onClose={() => setPicking(false)}
          onDone={(picked) => {
            setPicking(false)
            onChange(others.flatMap((place) => (picked.has(place.id) === enabled.has(place.id) ? [] : [{ id: place.id, on: picked.has(place.id) }])))
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * 「添加 agent、群或项目」: the forward sheet (ChatPickSheet) over the person's agents, then their groups, the ones talked in
 * recently first. A search finds an agent by its name, a group or project by its name, or a group by the name of a topic grown
 * out of it — said on its row; the topic itself is no place, its group is what is picked.
 */
function AppPlacesPicker({ places, chosen, onDone, onClose }: {
  places: readonly EnablePlace[]
  chosen: ReadonlySet<string>
  onDone: (picked: ReadonlySet<string>) => void
  onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [picked, setPicked] = useState(() => new Set(chosen))
  const [query, setQuery] = useState('')
  const q = query.trim().toLocaleLowerCase()
  // 「话题「x」在这个群里」 with x marked as a name is: the sentence around the topic's name.
  const [hintBefore, hintAfter] = t('chatArea.appEnable.topicHint', { name: '\u0000' }).split('\u0000')
  const recent = (kind: EnablePlace['kind']) => places.filter((place) => place.kind === kind).sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
  const rows = [...recent('agent'), ...recent('group')].flatMap((place): ChatPickRow[] => {
    const name = place.name ?? ''
    const byName = !q || name.toLocaleLowerCase().includes(q)
    const topic = byName || place.kind !== 'group' ? undefined : place.topics?.find((one) => one.toLocaleLowerCase().includes(q))
    if (!byName && topic === undefined) return []
    return [
      {
        id: place.id,
        name: highlightText(name, query.trim()),
        avatar: placeAvatar(place),
        badge: <PlaceMarks place={place} />,
        trailing: place.kind === 'group' ? <span className="gg-list-row-meta">{t('chatArea.appEnable.members', { count: place.memberCount ?? 0 })}</span> : undefined,
        hint: topic === undefined ? undefined : <span className={QUIET}>{hintBefore}{highlightText(topic, query.trim())}{hintAfter}</span>,
      },
    ]
  })
  return (
    <ChatPickSheet
      title={t('chatArea.appEnable.pickerTitle')}
      onClose={onClose}
      testId="app-places-picker"
      rows={rows}
      selected={picked}
      onToggle={(id) =>
        setPicked((now) => {
          const next = new Set(now)
          if (!next.delete(id)) next.add(id)
          return next
        })
      }
      query={query}
      onQuery={setQuery}
      placeholder={t('chatArea.appEnable.search')}
      empty={t(places.length === 0 ? 'chatArea.appEnable.noPlaces' : 'chatArea.appEnable.noMatch')}
      top={<div className={`${QUIET} px-4 pb-1 pt-3`}>{t('chatArea.appEnable.agents')} · {t('chatArea.appEnable.recent')}</div>}
      picked={t('chatArea.appEnable.picked', { count: picked.size })}
      actionLabel={t('chatArea.appEnable.done')}
      onAction={() => onDone(picked)}
      fullScreenMobile
    />
  )
}

/**
 * An App's row in 「App」, folded: 「给了：本机所有 agent · 周报助手 · sketch-rts 等 5 处」, the first three with their pictures.
 */
/** `machineName`: the places are another machine's (its App page): its agents are named as that machine's, not 「本机」. */
export function AppPlacesSummary({ places, machineName }: { places: readonly EnablePlace[]; machineName?: string }) {
  const { t } = useTranslation('messaging')
  const on = places.filter((place) => place.enabled)
  if (on.length === 0) return <span data-testid="app-places-summary">{t('chatArea.appEnable.none')}</span>
  const all = machineName ? t('chatArea.appEnable.hereAllOn', { machine: machineName }) : t('chatArea.appEnable.hereAll')
  const label = (place: EnablePlace) => (place.id === HERE_ALL ? all : (place.name ?? ''))
  const names = on.slice(0, 3).map(label).join(' · ')
  return (
    <span data-testid="app-places-summary" className="inline-flex min-w-0 items-center gap-1">
      {t('chatArea.appEnable.used')}
      <span className="inline-flex items-center gap-px">
        {on.slice(0, 3).map((place) =>
          place.kind === 'here' ? (
            <span key={place.id} className={`${TILE} size-[18px] bg-[var(--muted)]`}><Monitor size={11} /></span>
          ) : (
            <Avatar key={place.id} size="xs" {...placeAvatar(place)} />
          ),
        )}
      </span>
      <span className="min-w-0 truncate">{on.length > 3 ? t('chatArea.appEnable.more', { names, count: on.length }) : names}</span>
    </span>
  )
}
