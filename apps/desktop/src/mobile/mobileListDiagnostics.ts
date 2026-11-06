import { rendererLogger } from '@/lib/log'
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels'
import type { ChatKind } from '@gugu/core/shared/types/chat'

export type ShellListState = {
  activeTab: SidebarTab; pagerTab: SidebarTab; mobilePane: 'list' | 'chat'
  phoneLayerOpen: boolean; chatListHidden: boolean; tabBarVisible: boolean
}
export type ElementGeometry = {
  x: number; y: number; width: number; height: number
  display: string; visibility: string; contentVisibility: string; inert: boolean
}
export type ShellListGeometry = {
  online: boolean; foreground: boolean; viewport: [number, number]
  shell: ElementGeometry | null; pager: ElementGeometry | null
  listPane: ElementGeometry | null; list: ElementGeometry | null; me: ElementGeometry | null
  scrollLeft: number | null; scrollWidth: number | null
}
export type ListRowFacts = {
  kind: ChatKind; listed: boolean; rendered: boolean; searchMatch: boolean; owned: boolean
  imActivity: boolean; projectedActivity: boolean; selected: boolean; draft: boolean
}
type ShellSampleReason = 'commit' | 'viewport' | 'visibility'
type RowChange = ListRowFacts & { row: number | null; change: 'added' | 'changed' | 'removed' }
type Observation =
  | { event: 'shell'; reason: ShellSampleReason; state: ShellListState; geometry: ShellListGeometry }
  | { event: 'rows'; sourceCount: number; renderedCount: number; loading: boolean; changedCount: number; changes: RowChange[] }
  | { event: 'row-open'; row: number | null }
type Diagnostic = { sequence: number; at: number; suppressed: number } & Observation

/** Local, bounded metadata only. Raw IDs are used solely as in-memory correlation keys.
 * Nothing is persisted or sent over the network; feedback submission takes a copy.
 */
export function createMobileListDiagnostics(output: (entry: Diagnostic) => void = () => {}, now = Date.now) {
  let entries: Diagnostic[] = [], sequence = 0, windowAt = now(), emitted = 0, suppressed = 0
  let previous = new Map<string, ListRowFacts>(), lastCounts = '', shellSignature = ''
  const tokens = new Map<string, number>()
  const token = (id: string) => {
    if (!tokens.has(id) && tokens.size < 2048) tokens.set(id, tokens.size + 1)
    return tokens.get(id) ?? null
  }
  const emit = (input: Observation) => {
    const at = now()
    if (at - windowAt >= 60_000) { windowAt = at; emitted = 0 }
    if (emitted++ >= 60) { suppressed++; return }
    const entry = { ...input, sequence: ++sequence, at, suppressed } as Diagnostic
    suppressed = 0
    entries.push(entry)
    if (entries.length > 80) entries.shift()
    try { output(entry) } catch { /* Diagnostics never own navigation or list publication. */ }
  }
  return {
    shell(reason: ShellSampleReason, state: ShellListState, geometry: ShellListGeometry) {
      const signature = JSON.stringify([state, geometry])
      if (reason === 'commit' && signature === shellSignature) return
      shellSignature = signature
      emit({ event: 'shell', reason, state: { ...state }, geometry })
    },
    rows(rows: ReadonlyArray<{ id: string; facts: ListRowFacts }>, loading: boolean) {
      const next = new Map(rows.map(({ id, facts: f }) => [id, {
        kind: f.kind, listed: f.listed, rendered: f.rendered, searchMatch: f.searchMatch, owned: f.owned,
        imActivity: f.imActivity, projectedActivity: f.projectedActivity, selected: f.selected, draft: f.draft,
      }]))
      const changes: RowChange[] = []
      // Losses precede additions so a missing row survives truncation of a large refresh.
      for (const [id, facts] of previous) if (!next.has(id)) changes.push({ ...facts, row: token(id), change: 'removed' })
      for (const [id, facts] of next) {
        const old = previous.get(id)
        if (!old || JSON.stringify(old) !== JSON.stringify(facts)) changes.push({ ...facts, row: token(id), change: old ? 'changed' : 'added' })
      }
      const renderedCount = rows.filter(row => row.facts.rendered).length
      const counts = `${rows.length}/${renderedCount}/${loading}`
      previous = next
      if (!changes.length && counts === lastCounts) return
      lastCounts = counts
      emit({ event: 'rows', sourceCount: rows.length, renderedCount, loading, changedCount: changes.length, changes: changes.slice(0, 12) })
    },
    openRow(id: string) { emit({ event: 'row-open', row: token(id) }) },
    recent() { return { version: 1, entries: JSON.parse(JSON.stringify(entries)) as Diagnostic[], suppressed } },
    reset() {
      entries = []; previous.clear(); tokens.clear(); lastCounts = ''; shellSignature = ''
      sequence = 0; emitted = 0; suppressed = 0; windowAt = now()
    },
  }
}

const log = rendererLogger('mobile/list-diagnostics')
export const mobileListDiagnostics = createMobileListDiagnostics(entry => log.info(entry, 'Mobile list diagnostic'))
