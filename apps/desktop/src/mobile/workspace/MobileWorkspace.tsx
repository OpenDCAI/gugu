import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'
import '@/i18n/registerMobileWorkspaceCatalog'

export type MobileWorkspaceSection = 'projects' | 'groups'

/** Root-level sections share the existing task and chat surfaces; neither owns a second store. */
export function MobileWorkspace({ section, projects, groups }: {
  section: MobileWorkspaceSection
  projects: ReactNode
  groups: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const focused = lastFocus.current
    const previous = focused?.closest<HTMLElement>('[data-workspace-section]')
    if (!focused || !root.current?.contains(focused) || previous?.dataset.workspaceSection === section) return
    // Each retained surface owns its header tabs. Continue keyboard navigation in the now-visible header.
    if (document.activeElement === focused || document.activeElement === document.body) {
      root.current.querySelector<HTMLButtonElement>(`[data-workspace-section="${section}"] [role="tab"][aria-selected="true"]`)?.focus({ preventScroll: true })
    }
  }, [section])
  return (
    <div ref={root} onFocusCapture={(event) => { lastFocus.current = event.target }} className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="mobile-workspace">
      <div data-workspace-section="projects" inert={section !== 'projects'} className="flex min-h-0 flex-1 flex-col overflow-hidden" style={section !== 'projects' ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
        {projects}
      </div>
      <div data-workspace-section="groups" inert={section !== 'groups'} className="flex min-h-0 flex-1 flex-col overflow-hidden" style={section !== 'groups' ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
        {groups}
      </div>
    </div>
  )
}

export function MobileWorkspaceTabs({ value, onChange }: {
  value: MobileWorkspaceSection
  onChange: (next: MobileWorkspaceSection) => void
}) {
  const { t } = useTranslation('mobileWorkspace')
  return (
    <div className="shrink-0 px-[var(--pane-pad-x)] pb-1 [&_.gg-segtab]:min-h-[var(--control-h-touch)] [&_.gg-segtab]:flex-1 [&_.gg-segtab]:justify-center">
      <SegmentedTabs
        ariaLabel={t('title')}
        variant="pill"
        value={value}
        onChange={onChange}
        items={[
          { value: 'projects', label: t('projects'), testId: 'mobile-workspace-projects' },
          { value: 'groups', label: t('groups'), testId: 'mobile-workspace-groups' },
        ]}
      />
    </div>
  )
}
