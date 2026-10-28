import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@gugu/core/cloud/serverMachineHealth'
import { Archive, File, FileCode, FileImage, FileText, Monitor } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { markFileStorage, readFileStorageOverview, type FileStorageClass, type FileStorageOverview } from '../../lib/fileStorage'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives'
import '../usage/usage.css'

const CLASSES: readonly FileStorageClass[] = ['temporary', 'image', 'kept']
// The usage page's theme-following chart colors (its .gg-usage container below lends them).
const SWATCH: Record<FileStorageClass, string> = { temporary: 'bg-[var(--warn)]', image: 'bg-[var(--usage-accent-1)]', kept: 'bg-[var(--faint-fg)]' }
const FILL: Record<FileStorageClass, string> = { temporary: 'fill-[var(--warn)]', image: 'fill-[var(--usage-accent-1)]', kept: 'fill-[var(--faint-fg)]' }
const DAY = 86_400_000
type Expiring = FileStorageOverview['expiring'][number]
type SortKey = 'name' | 'group' | 'size' | 'expires'

function fileIcon(name: string | null, kind: FileStorageClass) {
  const suffix = name?.split('.').pop()?.toLowerCase() ?? ''
  if (kind === 'image' || /^(png|jpe?g|gif|webp|heic|svg)$/.test(suffix)) return FileImage
  if (/^(zip|rar|7z|tar|gz|tgz)$/.test(suffix)) return Archive
  if (/^(ts|tsx|js|py|go|rs|java|c|cpp|sh|json|ya?ml)$/.test(suffix)) return FileCode
  if (/^(pdf|docx?|txt|md|pptx?|key|xlsx?|csv)$/.test(suffix)) return FileText
  return File
}

/**
 * 「文件存储与读取」上半(owner 10-28 批的设计稿 evidence/file-storage-design):一条按类着色的用量条 + 一行数字;
 * 旁边一个次级按钮「从云端删除…」,二次确认里勾要删的类别;即将过期的文件一行一个、列对齐、表头可排序,默认 5 个;
 * 每台机器一行。只算自己上传的,数据是 chat.file_storage_overview_as 一次读回来的。删除只删云端副本(file_storage_mark_as
 * release),和发送时的「临时 / 一直保留」是同一个标记。❌ 环形图、柱状图、每行一个大按钮。
 */
export function FileStorageDashboard() {
  const { t } = useTranslation('settings')
  const [overview, setOverview] = useState<FileStorageOverview | null>(null)
  const [failed, setFailed] = useState('')
  const [cleaning, setCleaning] = useState(false)
  const [picked, setPicked] = useState<FileStorageClass[]>(['temporary'])
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'expires', dir: 1 })

  const load = useCallback(() => {
    let live = true
    setFailed('')
    readFileStorageOverview()
      .then((next) => { if (live) setOverview(next) })
      .catch((cause: unknown) => { if (live) setFailed(messageForUser(cause)) })
    return () => { live = false }
  }, [])
  useEffect(load, [load])

  if (!overview) {
    return failed
      ? <SettingsGroup title={t('fileStorage.dashboard.title')}>
          <SettingsRow description={failed} control={<Button variant="secondary" size="sm" onClick={load}>{t('fileStorage.retry')}</Button>} />
        </SettingsGroup>
      : <SettingsNote>{t('fileStorage.loading')}</SettingsNote>
  }
  const size = (bytes: number) => formatBytes(Number(bytes))
  const classLabel = (name: FileStorageClass) => t(`fileStorage.dashboard.classes.${name}`)
  const groupName = (chatId: string) => overview.groups.find((group) => group.chat_id === chatId)?.name ?? chatId.slice(0, 8)
  const days = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / DAY))
  const cleanable = (['temporary', 'image'] as const).filter((name) => overview.classes[name].count > 0)
  const chosen = picked.filter((name) => cleanable.includes(name as 'temporary' | 'image'))
  const chosenBytes = chosen.reduce((sum, name) => sum + Number(overview.classes[name].bytes), 0)
  const clean = () => {
    setBusy(true)
    setFailed('')
    markFileStorage(chosen.map((name) => ({ class: name })), 'release')
      .then(() => { setCleaning(false); load() })
      .catch((cause: unknown) => setFailed(messageForUser(cause)))
      .finally(() => setBusy(false))
  }

  const value = (file: Expiring, key: SortKey): string | number =>
    key === 'name' ? (file.file_name ?? classLabel(file.class)).toLowerCase()
      : key === 'group' ? groupName(file.chat_id).toLowerCase()
        : key === 'size' ? Number(file.bytes) : Date.parse(file.expires_at)
  const sorted = [...overview.expiring].sort((a, b) => {
    const x = value(a, sort.key), y = value(b, sort.key)
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
  })
  const shown = all ? sorted : sorted.slice(0, 5)
  const used = CLASSES.filter((name) => Number(overview.classes[name].bytes) > 0)
  const bytesOf = (name: FileStorageClass) => Number(overview.classes[name].bytes)
  const usedBytes = used.reduce((sum, name) => sum + bytesOf(name), 0)
  const segments = used.map((name, index) => {
    const before = used.slice(0, index).reduce((sum, other) => sum + bytesOf(other), 0)
    return { name, x: (before / usedBytes) * 1000 + (index ? 1 : 0), width: Math.max(0, (bytesOf(name) / usedBytes) * 1000 - (index ? 1 : 0) - (index < used.length - 1 ? 1 : 0)) }
  })
  const header = (key: SortKey, numeric = false) => (
    <th scope="col" className={numeric ? 'text-right' : 'text-left'} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <Button variant="ghost" size="sm" data-testid={`file-storage-sort-${key}`} className="min-h-0 px-0 text-[length:var(--font-caption)] font-medium hover:text-[var(--fg)]"
        onClick={() => setSort((current) => ({ key, dir: current.key === key ? (-current.dir as 1 | -1) : 1 }))}>
        {t(`fileStorage.dashboard.columns.${key}`)}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </Button>
    </th>
  )
  // A machine that keeps no project file and no temporary copy has nothing to say here.
  const machines = overview.machines.filter((machine) => Number(machine.files) > 0 || Number(machine.temporary_copy_bytes) > 0)
  const section = (title: string, aside: ReactNode, body: ReactNode, testId: string) => (
    <section data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[length:var(--font-body)] font-medium text-[var(--fg)]">{title}</span>
        <span className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">{aside}</span>
      </div>
      {body}
    </section>
  )

  return (
        <div className="gg-usage flex flex-col gap-[var(--spacing-2xl)]" data-testid="file-storage-dashboard">
      <section data-testid="file-storage-usage">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <span className="text-[length:var(--font-heading)] leading-7 font-semibold text-[var(--fg)]" data-testid="file-storage-total">{size(overview.total_bytes)}</span>
            <span className="ml-[6px] text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('fileStorage.dashboard.total', { count: overview.count })}</span>
          </div>
          <Popover.Root open={cleaning} onOpenChange={(open) => { setCleaning(open); if (open) setPicked(['temporary']) }}>
            <Popover.Trigger disabled={cleanable.length === 0}
              render={<Button variant="secondary" size="sm" data-testid="file-storage-clean">{t('fileStorage.dashboard.clean')}</Button>} />
            <Popover.Portal>
              {/* The settings panel sits at --z-settings; its popups go above it (as AddServerPanel's list). Portaled out of
                  the dashboard, the popup takes .gg-usage itself for the class colors. */}
              <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-[var(--z-settings-modal)]">
              <Popover.Popup data-testid="file-storage-clean-confirm" className="gg-usage w-[300px] rounded-[var(--radius-surface)] border border-[var(--border-strong)] bg-[var(--card)] p-[14px] text-[var(--fg)] shadow-lift">
                <Popover.Title className="m-0 text-[length:var(--font-body)] font-semibold">{t('fileStorage.dashboard.cleanTitle')}</Popover.Title>
                {cleanable.map((name) => (
                  <label key={name} className="flex items-center gap-2 py-[6px] text-[length:var(--font-body)]">
                    <input type="checkbox" data-testid={`file-storage-clean-${name}`} checked={picked.includes(name)}
                      onChange={(event) => setPicked((current) => event.target.checked ? [...current, name] : current.filter((other) => other !== name))} />
                    <span aria-hidden className={`size-2 rounded-full ${SWATCH[name]}`} />
                    {classLabel(name)}
                    <span className="ml-auto tabular-nums text-[var(--muted-fg)]">{size(overview.classes[name].bytes)}</span>
                  </label>
                ))}
                <Popover.Description className="m-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('fileStorage.dashboard.cleanNote')}</Popover.Description>
                {failed && <SettingsNote tone="danger">{failed}</SettingsNote>}
                <div className="mt-[10px] flex justify-end gap-2">
                  <Popover.Close render={<Button variant="ghost" size="sm" disabled={busy}>{t('fileStorage.dashboard.cancel')}</Button>} />
                  <Button variant="danger" size="sm" disabled={busy || chosen.length === 0} data-testid="file-storage-clean-go" onClick={clean}>
                    {t('fileStorage.dashboard.confirmClean', { size: size(chosenBytes) })}
                  </Button>
                </div>
              </Popover.Popup>
            </Popover.Positioner></Popover.Portal>
          </Popover.Root>
        </div>
        {/* One bar split by class, widths in proportion to bytes; a 2-unit gap between segments. */}
        <svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden className="mt-[10px] block h-[10px] w-full overflow-hidden rounded-full bg-[var(--muted)]">
          {segments.map(({ name, x, width }) => (
            <rect key={name} data-testid={`file-storage-bar-${name}`} x={x} y={0} width={width} height={10} className={FILL[name]} />
          ))}
        </svg>
        <div className="mt-[10px] flex flex-wrap gap-5 text-[length:var(--font-caption)] text-[var(--muted-fg)]">
          {CLASSES.map((name) => (
            <span key={name} data-testid={`file-storage-legend-${name}`} className="inline-flex items-center">
              <span aria-hidden className={`mr-[6px] size-2 rounded-full ${SWATCH[name]}`} />
              {classLabel(name)}
              <b className="ml-1 font-medium text-[var(--fg)]">{size(overview.classes[name].bytes)}</b>
              <span>&nbsp;· {t('fileStorage.dashboard.files', { count: overview.classes[name].count })}</span>
            </span>
          ))}
        </div>
      </section>

      {overview.expiring.length > 0 && section(t('fileStorage.dashboard.soonTitle'), null, <>
        <table className="w-full table-fixed border-collapse text-[length:var(--font-body)]" data-testid="file-storage-files">
          <colgroup><col /><col className="w-[120px]" /><col className="w-[84px]" /><col className="w-[104px]" /></colgroup>
          <thead className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">
            <tr className="[&>th]:border-b [&>th]:border-[var(--border-color)] [&>th]:px-2 [&>th]:pb-[6px]">
              {header('name')}{header('group')}{header('size', true)}{header('expires', true)}
            </tr>
          </thead>
          <tbody>
            {shown.map((file, index) => {
              const Icon = fileIcon(file.file_name, file.class)
              const left = days(file.expires_at)
              return (
                <tr key={`${file.item_id ?? file.chat_id}-${file.expires_at}-${index}`} data-testid="file-storage-file"
                  className="hover:bg-[var(--hover)] [&>td]:truncate [&>td]:border-b [&>td]:border-[var(--border-color)] [&>td]:px-2 [&>td]:py-[7px]">
                  <td><span className="flex min-w-0 items-center gap-2 text-[var(--fg)]">
                    <Icon size={16} className="shrink-0 text-[var(--muted-fg)]" />
                    <span className="truncate">{file.file_name ?? classLabel(file.class)}</span>
                  </span></td>
                  <td className="text-[var(--muted-fg)]">{groupName(file.chat_id)}</td>
                  <td className="text-right tabular-nums">{size(file.bytes)}</td>
                  <td className={left <= 2 ? 'text-right tabular-nums text-[var(--warn)]' : 'text-right tabular-nums'}>
                    {left === 0 ? t('fileStorage.dashboard.today') : t('fileStorage.dashboard.daysLeft', { count: left })}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {overview.expiring.length > 5 && (
          <Button variant="ghost" size="sm" data-testid="file-storage-show-all" onClick={() => setAll((current) => !current)}
            className="-ml-3 self-start text-[var(--fg)]">
            {all ? t('fileStorage.dashboard.showLess') : t('fileStorage.dashboard.showAll', { count: overview.expiring.length })}
          </Button>
        )}
      </>, 'file-storage-expiring')}

      {machines.length > 0 && section(t('fileStorage.dashboard.machinesTitle'), t('fileStorage.dashboard.machinesNote'),
        <div className="-mx-3 flex flex-col">
          {machines.map((machine) => (
            // The Devices page's row: icon tile, the machine's name, one caption line.
            <div key={machine.device_id} data-testid="file-storage-machine"
              className="flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-[10px] hover:bg-[var(--hover)]">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--muted)] text-[var(--muted-fg)]"><Monitor size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[length:var(--font-body)] font-semibold text-[var(--fg)]">{machine.label}</div>
                <div className="truncate text-[length:var(--font-caption)] text-[var(--muted-fg)]">
                  {t(Number(machine.temporary_copy_bytes) > 0 ? 'fileStorage.dashboard.machineHint' : 'fileStorage.dashboard.machineHintNone',
                    { count: Number(machine.files), size: size(machine.bytes), copies: size(machine.temporary_copy_bytes) })}
                </div>
              </div>
              <span className="tabular-nums text-[length:var(--font-body)] text-[var(--muted-fg)]">{size(machine.bytes)}</span>
            </div>
          ))}
        </div>, 'file-storage-machines')}
    </div>
  )
}
