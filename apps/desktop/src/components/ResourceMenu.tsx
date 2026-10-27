import type { ReactElement } from 'react'
import type { ResourceContext } from '@/session/shared/resource-actions'
import { resourceMenuItems } from '@/lib/resourceActions'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/session/renderer/lib/ui/context-menu'

/** Whole-row right click and touch long press; nested controls keep their own interaction. */
export function ResourceMenu({ resource, children }: { resource: ResourceContext; children: ReactElement }) {
  return <ContextMenu onOpenChange={(open, details) => {
    const target = details.event?.target
    if (open && target instanceof Element && target.closest('button,input,textarea,select,a,[role="radio"],[role="switch"]')) details.cancel()
  }}>
    <ContextMenuTrigger render={children} />
    <ContextMenuContent onClick={event => event.stopPropagation()}>
      {resourceMenuItems(resource).map(item => <ContextMenuItem key={item.id} onClick={() => void item.click()}>{item.label}</ContextMenuItem>)}
    </ContextMenuContent>
  </ContextMenu>
}
