import { cn } from '@/lib/cn'
import type { RailApp } from '../session/renderer/features/extensions/installed-extensions-store'
import { extensionMonogram } from '../session/shared/extensions/catalog'
import './Sidebar.css'

/** An App's own icon, or its first letter on a tinted square — on the rail, and in the lists that open an App (the rail's right click, a chat's ⋯). */
export function RailAppIcon({ app, className }: { app: RailApp; className?: string }) {
  return app.iconDataUrl
    ? <img className={cn('gg-sidebar-app-icon', className)} src={app.iconDataUrl} alt="" />
    : <span className={cn('gg-sidebar-app-icon gg-sidebar-app-letter', className)} aria-hidden="true">{extensionMonogram(app.name)}</span>
}
