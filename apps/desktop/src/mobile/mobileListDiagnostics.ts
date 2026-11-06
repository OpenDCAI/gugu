import { rendererLogger } from '@/lib/log'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import type { ChatKind } from '@gugu/core/shared/types/chat'

export type ShellListState = {
  activeTab: SidebarTab | 'unknown'; pagerTab: SidebarTab | 'unknown'; mobilePane: 'list' | 'chat'
  phoneLayerOpen: boolean; chatListHidden: boolean; tabBarVisible: boolean
}
export type ElementGeometry = {
  x: number; y: number; width: number; height: number
  display: 'none' | 'contents' | 'box'; visibility: 'visible' | 'hidden' | 'collapse'
  contentVisibility: 'visible' | 'hidden' | 'auto'; inert: boolean
}
export type ShellListGeometry = {
  online: boolean; foreground: boolean; viewport: [number, number]
  shell: ElementGeometry | null; pager: ElementGeometry | null
  listPane: ElementGeometry | null; list: ElementGeometry | null; me: ElementGeometry | null
  scrollLeft: number | null; scrollWidth: number | null
}
export type ListRowFacts = {
  kind: ChatKind | 'unknown'; listed: boolean; rendered: boolean; searchMatch: boolean; owned: boolean
  imActivity: boolean; projectedActivity: boolean; selected: boolean; draft: boolean
}
type ShellSampleReason = 'commit' | 'viewport' | 'visibility'
type RowChange = ListRowFacts & { row: string | null; change: 'added' | 'changed' | 'removed' }
type Observation =
  | { event: 'shell'; reason: ShellSampleReason; state: ShellListState; geometry: ShellListGeometry }
  | { event: 'rows'; sourceCount: number; renderedCount: number; loading: boolean; changedCount: number; changes: RowChange[] }
  | { event: 'row-open'; row: string | null }
type Diagnostic = { sequence: number; at: number; suppressed: number } & Observation

/** Local, bounded metadata only. Raw IDs are used solely as in-memory correlation keys.
 * Nothing is persisted or sent over the network; feedback submission takes a copy.
 */
export function createMobileListDiagnostics(output: (entry: Diagnostic) => void = () => {}, now = Date.now) {
  let entries: Diagnostic[] = [], sequence = 0, windowAt = now(), emitted = 0, suppressed = 0
  let previous = new Map<string, ListRowFacts>(), lastCounts = '', shellSignature = ''
  let generation = 0, queued = 0, pending = Promise.resolve(), key: Promise<CryptoKey> | undefined
  const tokens = new Map<string, Promise<string | null>>()
  const token = (id: string) => {
    if (!tokens.has(id) && tokens.size < 2048) {
      const hash = async () => {
        try {
          // A non-extractable random key per signed-in shell lifetime. Never stored or logged.
          key ??= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
          const bytes = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(id))
          return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
        } catch { return null } // No error text or unsafe unhashed fallback enters a diagnostic.
      }
      tokens.set(id, hash())
    }
    return tokens.get(id) ?? Promise.resolve(null)
  }
  const emit = (input: () => Observation | Promise<Observation>) => {
    const at = now()
    if (at - windowAt >= 60_000) { windowAt = at; emitted = 0 }
    if (emitted++ >= 60 || queued >= 80) { suppressed++; return pending }
    const owner = generation, metadata = { sequence: ++sequence, at, suppressed }
    suppressed = 0
    queued++
    // Hash asynchronously without delaying UI work; keep original observation order and ownership.
    let observed: Promise<Observation>
    try { observed = Promise.resolve(input()) } catch { suppressed++; queued--; return pending }
    pending = Promise.all([pending, observed]).then(([, observation]) => {
      if (owner !== generation) return
      const entry = { ...observation, ...metadata } as Diagnostic
      entries.push(entry)
      if (entries.length > 80) entries.shift()
      try { output(entry) } catch { /* Diagnostics never own navigation or list publication. */ }
    }).catch(() => { if (owner === generation) suppressed++ }).finally(() => { if (owner === generation) queued-- })
    return pending
  }
  return {
    shell(reason: ShellSampleReason, state: ShellListState, geometry: ShellListGeometry) {
      const signature = JSON.stringify([state, geometry])
      if (reason === 'commit' && signature === shellSignature) return
      shellSignature = signature
      const tab = (value: ShellListState['activeTab']) =>
        value === 'chats' || value === 'contacts' || value === 'tasks' || value === 'settings' || value === 'assistant' ? value : 'unknown'
      return emit(() => ({ event: 'shell', reason, state: {
        activeTab: tab(state.activeTab), pagerTab: tab(state.pagerTab), mobilePane: state.mobilePane === 'chat' ? 'chat' : 'list',
        phoneLayerOpen: !!state.phoneLayerOpen, chatListHidden: !!state.chatListHidden, tabBarVisible: !!state.tabBarVisible,
      }, geometry }))
    },
    rows(rows: ReadonlyArray<{ id: string; facts: ListRowFacts }>, loading: boolean) {
      const next = new Map<string, ListRowFacts>(rows.map(({ id, facts: f }) => [id, {
        kind: f.kind === 'dm' || f.kind === 'ai' || f.kind === 'group' || f.kind === 'topic' ? f.kind : 'unknown',
        listed: !!f.listed, rendered: !!f.rendered, searchMatch: !!f.searchMatch, owned: !!f.owned,
        imActivity: !!f.imActivity, projectedActivity: !!f.projectedActivity, selected: !!f.selected, draft: !!f.draft,
      }]))
      const changes: Array<ListRowFacts & { id: string; change: RowChange['change'] }> = []
      // Losses precede additions so a missing row survives truncation of a large refresh.
      for (const [id, facts] of previous) if (!next.has(id)) changes.push({ ...facts, id, change: 'removed' })
      for (const [id, facts] of next) {
        const old = previous.get(id)
        if (!old || JSON.stringify(old) !== JSON.stringify(facts)) changes.push({ ...facts, id, change: old ? 'changed' : 'added' })
      }
      const renderedCount = rows.filter(row => row.facts.rendered).length
      const counts = `${rows.length}/${renderedCount}/${loading}`
      previous = next
      if (!changes.length && counts === lastCounts) return
      lastCounts = counts
      return emit(async () => ({ event: 'rows', sourceCount: rows.length, renderedCount, loading, changedCount: changes.length,
        changes: await Promise.all(changes.slice(0, 12).map(async ({ id, ...facts }) => ({ ...facts, row: await token(id) }))),
      }))
    },
    openRow(id: string) { return emit(async () => ({ event: 'row-open', row: await token(id) })) },
    recent() { return { version: 1, entries: JSON.parse(JSON.stringify(entries)) as Diagnostic[], suppressed } },
    settled() { return pending },
    reset() {
      generation++; queued = 0; pending = Promise.resolve(); key = undefined
      entries = []; previous.clear(); tokens.clear(); lastCounts = ''; shellSignature = ''
      sequence = 0; emitted = 0; suppressed = 0; windowAt = now()
    },
  }
}

const log = rendererLogger('mobile/list-diagnostics')
export const mobileListDiagnostics = createMobileListDiagnostics(entry => log.info(entry, 'Mobile list diagnostic'))
