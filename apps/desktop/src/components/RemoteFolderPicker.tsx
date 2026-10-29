import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderPlus, FileText, Home, Link as LinkIcon, RefreshCw } from '@/lib/icons'
import { deviceFsListDirectory, deviceFsMakeDirectory } from '../lib/deviceFs'
import type { DeviceFsEntry, DeviceFsListResult } from '@gugu/core/cloud/deviceFsProtocol'
import type { DeviceRpcError } from '../lib/deviceRpc'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { rendererLogger } from '../lib/log'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { SearchField } from './ui/SearchField'
import {
  broadRootKind,
  completionCandidates,
  filterEntries,
  isEnterable,
  joinPath,
  newFolderNameProblem,
  pathSegments,
  sortEntries,
  splitCompletionDraft,
} from './remoteFolderPath'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

const LIST_DIRECTORY_TIMEOUT_MS = 20_000
const COMPLETION_DEBOUNCE_MS = 150
const log = rendererLogger('remote-folder-picker')

type Props = {
  deviceId: string
  initialPath?: string
  onSelect: (path: string) => void
  onCancel?: () => void
}

/** 手上这份目录读数:选择器永远停在一个**确实存在**的文件夹上,选中的就是它。 */
type Listing = { path: string; entries: DeviceFsEntry[] }

/**
 * 最近一次「去某个路径」没去成的原因。它不替换手上那份读数 —— 去不成就留在原地、说清楚为什么,
 * ❌ 不再像旧版那样自己跳回上一级、再被下一次读取把错误抹掉(那样用户只看到目录闪了一下)。
 */
type NavError =
  | { kind: 'rpc'; path: string; error: DeviceRpcError }
  | { kind: 'timeout'; path: string }
  | { kind: 'unreachable'; path: string }

type NewFolderState = { name: string; busy: boolean; error: string | null }

function navErrorMessage(error: NavError, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (error.kind === 'timeout') return t('create.remoteFolders.error.timeout')
  if (error.kind === 'unreachable') return t('create.remoteFolders.error.unreachable')
  const path = error.path
  switch (error.error.code) {
    case 'path_blocked':
      return t('create.remoteFolders.error.pathBlocked')
    case 'permission_denied':
      return t('create.remoteFolders.error.permissionDeniedPath', { path })
    case 'not_found':
      return t('create.remoteFolders.error.notFoundPath', { path })
    case 'not_a_directory':
      return t('create.remoteFolders.error.notDirectoryPath', { path })
    case 'invalid_path':
      return t('create.remoteFolders.error.invalidPath')
    case 'unauthorized':
      return t('create.remoteFolders.error.unauthorized')
    default:
      // 内部错误原文进日志,界面只说发生了什么、下一步做什么。
      return t('create.remoteFolders.error.unknown')
  }
}

function entryIcon(kind: DeviceFsEntry['kind']) {
  if (kind === 'dir') return <Folder size={14} />
  if (kind === 'symlink') return <LinkIcon size={14} />
  return <FileText size={14} />
}

export function RemoteFolderPicker({ deviceId, initialPath = '~', onSelect, onCancel }: Props) {
  const { t } = useTranslation('agents')
  const [listing, setListing] = useState<Listing | null>(null)
  /** 那台机器上的主目录。新版本的机器每次列目录都报;老版本的只能从「列 ~ 得到的路径」认出来。 */
  const [home, setHome] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // @@@remote-dir-progress (#848) - show elapsed seconds while loading so the wait for the remote
  // device-RPC never reads as a frozen "永远 loading" (the call times out at LIST_DIRECTORY_TIMEOUT_MS).
  const [loadElapsed, setLoadElapsed] = useState(0)
  const loadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [navError, setNavError] = useState<NavError | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [truncatedCount, setTruncatedCount] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [confirmBroad, setConfirmBroad] = useState<'root' | 'home' | null>(null)
  const [newFolder, setNewFolder] = useState<NewFolderState | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastRequestRef = useRef<{ path: string; hidden: boolean }>({ path: initialPath, hidden: false })

  /**
   * 地址栏可以直接输入路径(与访达「前往文件夹」、文件选择框敲 `/` 同一个习惯):已知路径时一层层点太慢,
   * 尤其是服务器上动辄十几层的目录(owner 反馈「如果能输入路径会方便很多」)。
   * null = 不在编辑;字符串 = 正在编辑的草稿。回车前往,Tab 补全,Esc 放弃。
   */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const [completion, setCompletion] = useState<{ dir: string; entries: DeviceFsEntry[] } | null>(null)
  const [highlight, setHighlight] = useState(-1)

  const stopTimer = useCallback(() => {
    if (loadTimerRef.current) { clearInterval(loadTimerRef.current); loadTimerRef.current = null }
  }, [])

  const navigate = useCallback(
    async (path: string, hidden: boolean) => {
      lastRequestRef.current = { path, hidden }
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      setLoadElapsed(0)
      stopTimer()
      loadTimerRef.current = setInterval(() => setLoadElapsed((s) => s + 1), 1000)
      setNavError(null)
      setConfirmBroad(null)
      try {
        const response = await deviceFsListDirectory(
          deviceId,
          { path, show_hidden: hidden },
          // @@@remote-dir-no-retry (#670) - a directory listing either resolves or it doesn't; retrying
          { signal: controller.signal, timeoutMs: LIST_DIRECTORY_TIMEOUT_MS, retryOnTimeout: false },
        )
        if (controller.signal.aborted) return
        const result: DeviceFsListResult | undefined = response.result
        if (!result) {
          const error = response.error ?? { code: 'internal_error', message: 'empty response' }
          if (response.error?.code && !['not_found', 'not_a_directory', 'permission_denied', 'path_blocked', 'invalid_path'].includes(response.error.code)) {
            log.warn({ deviceId, path, error }, 'list-directory failed')
          }
          setNavError({ kind: 'rpc', path, error })
          return
        }
        setListing({ path: result.path, entries: sortEntries(result.entries) })
        if (result.home) setHome(result.home)
        else if (path === '~') setHome(result.path)
        setFilter('')
        setNewFolder(null)
        setTruncatedCount(response.error?.code === 'too_many_entries' ? result.entries.length : null)
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return
        // @@@remote-dir-timeout-hint (#670) - surface the device-RPC timeout as an actionable message
        // (host unreachable / old build) instead of the raw "设备 RPC timed out after Nms" string.
        log.warn({ deviceId, path, error: String((err as Error)?.message ?? err) }, 'list-directory threw')
        setNavError({ kind: (err as Error)?.name === 'DeviceRpcTimeoutError' ? 'timeout' : 'unreachable', path })
      } finally {
        if (!controller.signal.aborted) {
          stopTimer()
          setLoading(false)
        }
      }
    },
    [deviceId, stopTimer],
  )

  // 首次打开:先去调用方给的起点;那里去不了(被删了、没权限)就退回主目录,❌ 停在一片空白上。
  useEffect(() => {
    void navigate(initialPath, false)
    return () => {
      abortRef.current?.abort()
      // @@@1647 卸载/重跑即清 elapsed 计时器,**别依赖 navigate 的 async finally**:卸载后 await 未 settle 时
      // interval 仍会 tick → setState on unmounted → 测试环境 `window is not defined`(污染全员 CI 的 flaky)。
      stopTimer()
    }
  }, [initialPath, navigate, stopTimer])
  useEffect(() => {
    if (listing || loading || !navError || navError.kind !== 'rpc') return
    if (navError.path === '~') return
    if (['not_found', 'not_a_directory', 'permission_denied', 'path_blocked'].includes(navError.error.code)) {
      void navigate('~', showHidden)
    }
  }, [listing, loading, navError, navigate, showHidden])


  const goTo = useCallback((path: string) => { void navigate(path, showHidden) }, [navigate, showHidden])
  const retry = useCallback(() => {
    const last = lastRequestRef.current
    void navigate(last.path, last.hidden)
  }, [navigate])

  // ── 地址栏补全 ─────────────────────────────────────────────────────────────
  const draftSplit = pathDraft === null ? null : splitCompletionDraft(pathDraft)
  const completionDir = draftSplit?.dir ?? null
  useEffect(() => {
    if (completionDir === null) { setCompletion(null); return }
    // 正在看的就是这个目录:直接用手上的读数,不再跨云问一趟。
    if (listing && (completionDir === listing.path || (completionDir === '~' && home === listing.path))) {
      setCompletion({ dir: completionDir, entries: listing.entries })
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void deviceFsListDirectory(deviceId, { path: completionDir, show_hidden: true }, { timeoutMs: LIST_DIRECTORY_TIMEOUT_MS, retryOnTimeout: false })
        .then((response) => {
          if (live) setCompletion({ dir: completionDir, entries: response.result?.entries ?? [] })
        })
        .catch(() => { if (live) setCompletion({ dir: completionDir, entries: [] }) })
    }, COMPLETION_DEBOUNCE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [completionDir, deviceId, home, listing])
  const suggestions = useMemo(
    () => (draftSplit && completion && completion.dir === draftSplit.dir ? completionCandidates(completion.entries, draftSplit.prefix) : []),
    [completion, draftSplit],
  )
  useEffect(() => { setHighlight(-1) }, [pathDraft])

  const startEditingPath = useCallback((initial?: string) => {
    setPathDraft(initial ?? listing?.path ?? initialPath)
    requestAnimationFrame(() => {
      const input = pathInputRef.current
      if (!input) return
      input.focus()
      if (initial === undefined) input.select()
    })
  }, [initialPath, listing])
  const acceptSuggestion = useCallback((entry: DeviceFsEntry) => {
    if (!draftSplit) return
    setPathDraft(joinPath(draftSplit.dir, entry.name) + '/')
    requestAnimationFrame(() => pathInputRef.current?.focus())
  }, [draftSplit])
  const commitPathDraft = useCallback(() => {
    const picked = highlight >= 0 ? suggestions[highlight] : undefined
    const target = picked && draftSplit ? joinPath(draftSplit.dir, picked.name) : pathDraft?.trim()
    setPathDraft(null)
    if (target) goTo(target.length > 1 ? target.replace(/\/+$/, '') : target)
  }, [draftSplit, goTo, highlight, pathDraft, suggestions])

  // ── 新建文件夹 ─────────────────────────────────────────────────────────────
  const submitNewFolder = useCallback(async () => {
    if (!listing || !newFolder || newFolder.busy) return
    const problem = newFolderNameProblem(newFolder.name)
    if (problem) {
      setNewFolder({ ...newFolder, error: t(problem === 'empty' ? 'create.remoteFolders.newFolderError.empty' : 'create.remoteFolders.newFolderError.invalid') })
      return
    }
    const target = joinPath(listing.path, newFolder.name.trim())
    setNewFolder({ ...newFolder, busy: true, error: null })
    try {
      const response = await deviceFsMakeDirectory(deviceId, target, { timeoutMs: LIST_DIRECTORY_TIMEOUT_MS })
      if (response.result) {
        setNewFolder(null)
        goTo(response.result.path)
        return
      }
      const code = response.error?.code
      const key =
        code === 'already_exists' ? 'exists'
          : code === 'permission_denied' ? 'permission'
          : code === 'invalid_path' ? 'invalid'
          : code === 'unknown_method' ? 'unsupported'
          : 'unknown'
      if (key === 'unknown') log.warn({ deviceId, target, error: response.error }, 'make-directory failed')
      setNewFolder((current) => current && { ...current, busy: false, error: t(`create.remoteFolders.newFolderError.${key}`) })
    } catch (err) {
      log.warn({ deviceId, target, error: String((err as Error)?.message ?? err) }, 'make-directory threw')
      setNewFolder((current) => current && { ...current, busy: false, error: t('create.remoteFolders.newFolderError.unknown') })
    }
  }, [deviceId, goTo, listing, newFolder, t])

  // ── 选中 ───────────────────────────────────────────────────────────────────
  const canUsePath = !loading && listing !== null
  const choose = useCallback((force = false) => {
    if (!listing || loading) return
    const broad = broadRootKind(listing.path, home)
    if (broad && !force) { setConfirmBroad(broad); return }
    abortRef.current?.abort()
    onSelect(listing.path)
  }, [home, listing, loading, onSelect])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (pathDraft !== null || newFolder) return
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel?.()
        return
      }
      // 直接敲 `/` 或 `~` = 开始输入路径(文件选择框的通行做法),⌘L / Ctrl+L 同理。
      if ((event.key === '/' || event.key === '~') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        startEditingPath(event.key)
        return
      }
      if (event.key.toLowerCase() === 'l' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        startEditingPath()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        choose()
      }
    },
    [choose, newFolder, onCancel, pathDraft, startEditingPath],
  )

  // 打开时焦点落进选择框:否则直接敲 `/home/...` 哪儿也不去(实测),「敲 / 就开始输路径」形同虚设。
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const segments = useMemo(() => pathSegments(listing?.path ?? ''), [listing])
  const visibleEntries = useMemo(() => filterEntries(listing?.entries ?? [], filter), [filter, listing])
  const initialLoading = loading && listing === null
  const selectedPath = listing?.path ?? ''
  const atHome = Boolean(listing && home && listing.path === home)

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('create.remoteFolders.title')}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        // 它总是装在一张 Sheet 里(创建框的「浏览那台机器上的文件夹」):Sheet 已经是那一层浮起的面,
        // 这里 ❌ 再画一圈框 + 一层底色(box inside a box)。行数预算(design.md):只留三段之间的两条分界线
        // (地址栏 | 列表 | 底栏),其余提示条一律是 callout(一条色线 + 密度底),❌ 再各画一条 border。
        'flex h-[420px] max-h-[70dvh] flex-col overflow-hidden outline-none',
      )}
    >
      {/* 地址栏:主目录捷径 · 面包屑(点任意一级回去)· 点空白进入输入 · 刷新 */}
      <div className="relative flex min-h-10 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-secondary)]">
        <IconButton
          size="sm"
          aria-label={t('create.remoteFolders.home')}
          title={t('create.remoteFolders.home')}
          onClick={() => goTo('~')}
          disabled={loading || atHome}
          data-testid="remote-folder-home"
        >
          <Home size={14} />
        </IconButton>
        {pathDraft !== null ? (
          <input
            ref={pathInputRef}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                commitPathDraft()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setPathDraft(null)
              } else if (event.key === 'Tab' && suggestions.length > 0) {
                event.preventDefault()
                acceptSuggestion(suggestions[Math.max(0, highlight)])
              } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
                event.preventDefault()
                setHighlight((h) => (h + 1) % suggestions.length)
              } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                event.preventDefault()
                setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
              }
            }}
            onBlur={() => setPathDraft(null)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="remote-folder-path-suggestions"
            aria-label={t('create.remoteFolders.pathInput')}
            placeholder={t('create.remoteFolders.pathPlaceholder')}
            data-testid="remote-folder-path-input"
            className={cn(
              'min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--bg-primary)] px-2 py-1',
              'font-mono text-[length:var(--font-body)] text-[var(--text-primary)] outline-none',
            )}
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap items-center" onClick={(event) => { if (event.target === event.currentTarget) startEditingPath() }}>
              {segments.map((segment, index) => {
                const last = index === segments.length - 1
                return (
                  <span key={`${segment.path}-${index}`} className="inline-flex items-center">
                    {index > 0 && <ChevronRight size={11} color="var(--text-tertiary)" />}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => goTo(segment.path)}
                      disabled={loading}
                      className={cn('min-h-6 px-1', last ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--accent)]')}
                    >
                      {segment.label}
                    </Button>
                  </span>
                )
              })}
              {/*
                点路径条空白处进入输入:整条就是地址栏(照访达 / 资源管理器的地址栏),所以 ❌ 另摆一枚铅笔 ——
                点路径本来就能改,再给一颗钮是同一件事的第二个入口。
                这块空白本身是个按钮:Tab 到它、回车 / 空格也进入输入(另有 `/`、`~`、⌘L 直接开始输)。
              */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startEditingPath()}
                title={t('create.remoteFolders.pathInput')}
                data-testid="remote-folder-path-blank"
                className="min-h-6 min-w-6 flex-1 self-stretch cursor-text px-0"
              >
                <span className="sr-only">{t('create.remoteFolders.pathInput')}</span>
              </Button>
            </div>
          </>
        )}
        <IconButton
          size="sm"
          onClick={retry}
          disabled={loading}
          title={t('create.remoteFolders.refresh')}
          aria-label={t('create.remoteFolders.refresh')}
        >
          <RefreshCw size={12} />
        </IconButton>
        {pathDraft !== null && suggestions.length > 0 ? (
          <ul
            id="remote-folder-path-suggestions"
            role="listbox"
            data-testid="remote-folder-path-suggestions"
            // 浮层公式(docs/ui-visual-spec.md §6.3):--radius-surface + 唯一那档 lift,❌ 再叠一圈 border。
            className="absolute top-full right-2 left-9 z-10 m-0 mt-1 list-none rounded-[var(--radius-surface)] bg-[var(--popover)] p-1 shadow-[var(--shadow-lift)]"
          >
            {suggestions.map((entry, index) => (
              <li
                key={entry.name}
                role="option"
                aria-selected={index === highlight}
                // mousedown 而不是 click:click 之前输入框先失焦,草稿就被收掉了。
                onMouseDown={(event) => { event.preventDefault(); acceptSuggestion(entry) }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)]',
                  index === highlight ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]',
                )}
              >
                <span className="inline-flex text-[var(--accent)]">{entryIcon(entry.kind)}</span>
                <span className="truncate font-mono">{entry.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* 工具条:筛选这个文件夹 · 新建文件夹 */}
      {listing ? (
        <div className="flex items-center gap-2 px-2 py-2">
          <SearchField
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('create.remoteFolders.filterPlaceholder')}
            clearLabel={t('create.remoteFolders.filterClear')}
            onClear={() => setFilter('')}
            className="h-7"
            data-testid="remote-folder-filter"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={loading || newFolder !== null}
            onClick={() => setNewFolder({ name: '', busy: false, error: null })}
            data-testid="remote-folder-new"
          >
            <FolderPlus size={14} />
            {t('create.remoteFolders.newFolder')}
          </Button>
        </div>
      ) : null}

      {truncatedCount !== null && (
        <div role="status" className="mx-2 mb-1 border-l-2 border-[var(--warn)] bg-foreground/[0.025] px-2 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] dark:bg-foreground/[0.04]">
          {t('create.remoteFolders.truncated', { count: truncatedCount })}
        </div>
      )}

      {/* 去不成的原因:留在原地、说清楚、给重试。手上有读数时列表照常可用。 */}
      {navError && !initialLoading ? (
        <div role="alert" className="mx-2 mb-1 flex items-center gap-2 border-l-2 border-[var(--danger)] bg-foreground/[0.025] px-3 py-2 text-[length:var(--font-body)] text-[var(--danger-fg)] dark:bg-foreground/[0.04]">
          <span className="min-w-0 flex-1">{navErrorMessage(navError, t)}</span>
          <Button variant="secondary" size="sm" className="shrink-0" onClick={retry}>
            {t('create.remoteFolders.retry')}
          </Button>
        </div>
      ) : null}

      <div className={cn('relative flex-1 overflow-auto', loading && listing && 'opacity-60')}>
        {initialLoading ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 py-3 text-[var(--text-secondary)]">
            {/* 在连那台机器:全产品唯一的加载态(product spec),计秒写在它下面那行字里。 */}
            <LoadingIndicator
              ariaLabel={t('create.remoteFolders.connecting', { seconds: loadElapsed })}
              label={t('create.remoteFolders.connecting', { seconds: loadElapsed })}
            />
          </div>
        ) : null}
        {newFolder ? (
          <div className="flex flex-col gap-1 px-2 py-2">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newFolder.name}
                disabled={newFolder.busy}
                onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value, error: null })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submitNewFolder() }
                  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNewFolder(null) }
                }}
                spellCheck={false}
                aria-label={t('create.remoteFolders.newFolder')}
                placeholder={t('create.remoteFolders.newFolderPlaceholder')}
                data-testid="remote-folder-new-name"
                className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--bg-primary)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none"
              />
              <Button variant="primary" size="sm" disabled={newFolder.busy} onClick={() => void submitNewFolder()}>
                {newFolder.busy ? <LoadingIndicator size="inline" /> : null}
                {t('create.remoteFolders.newFolderCreate')}
              </Button>
              <Button variant="ghost" size="sm" disabled={newFolder.busy} onClick={() => setNewFolder(null)}>
                {t('common.cancel')}
              </Button>
            </div>
            {newFolder.error ? (
              <span role="alert" className="text-[length:var(--font-caption)] text-[var(--danger-fg)]">{newFolder.error}</span>
            ) : null}
          </div>
        ) : null}
        {listing && !initialLoading && listing.entries.length === 0 ? (
          <div className="px-3 py-3 text-[length:var(--font-body)] text-[var(--text-tertiary)]">{t('create.remoteFolders.empty')}</div>
        ) : null}
        {listing && listing.entries.length > 0 && visibleEntries.length === 0 ? (
          <div className="px-3 py-3 text-[length:var(--font-body)] text-[var(--text-tertiary)]">
            {t('create.remoteFolders.filterNoMatch', { query: filter.trim() })}
          </div>
        ) : null}
        {listing ? (
          <ul className="m-0 list-none p-1">
            {visibleEntries.map((entry) => {
              const enterable = isEnterable(entry)
              return (
                <li key={entry.name}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { if (enterable) goTo(joinPath(listing.path, entry.name)) }}
                    disabled={!enterable || loading}
                    className={cn(
                      'w-full justify-start gap-2 px-2 font-normal',
                      enterable ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                    )}
                  >
                    <span className={cn('inline-flex items-center', enterable ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                      {entryIcon(entry.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>

      {/* 选根目录 / 主目录本身当项目:先问一句(Zed 同样提醒「别开太大的目录」)。 */}
      {confirmBroad ? (
        <div role="alert" data-testid="remote-folder-broad-confirm" className="mx-2 mb-2 flex flex-wrap items-center gap-2 border-l-2 border-[var(--warn)] bg-foreground/[0.025] px-3 py-2 text-[length:var(--font-body)] text-[var(--text-primary)] dark:bg-foreground/[0.04]">
          <span className="min-w-0 flex-1">
            {t(confirmBroad === 'root' ? 'create.remoteFolders.broadRoot' : 'create.remoteFolders.broadHome')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmBroad(null)}>
            {t('create.remoteFolders.broadPickAnother')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => choose(true)} data-testid="remote-folder-broad-use">
            {t('create.remoteFolders.broadUseAnyway')}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-2 py-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
        <label className="inline-flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => {
              setShowHidden(event.target.checked)
              void navigate(listing?.path ?? lastRequestRef.current.path, event.target.checked)
            }}
            className="m-0"
          />
          {t('create.remoteFolders.showHidden')}
        </label>
        <span className="whitespace-nowrap">
          {loading ? t('create.remoteFolders.loading') : listing ? t('create.remoteFolders.itemCount', { count: listing.entries.length }) : ''}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={selectedPath}>
          {selectedPath}
        </span>
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={() => choose()} disabled={!canUsePath}>
          {t('create.remoteFolders.use')}
        </Button>
      </div>
    </div>
  )
}
