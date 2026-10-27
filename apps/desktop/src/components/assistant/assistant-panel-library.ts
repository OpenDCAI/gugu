import { assistantPanelCollection, AssistantPanelError, type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { UserLibraryEntry, UserLibraryKind, UserLibraryRead, UserLibraryWrite } from '@/session/shared/user-library'

const domain = (kind: UserLibraryKind) => kind === 'capabilities' ? 'capabilities' as const : 'device-notes' as const
function metadata(item: AssistantPanelItem): Omit<UserLibraryEntry, 'content'> {
  if (typeof item.data.name !== 'string' || typeof item.data.description !== 'string') throw new AssistantPanelError('invalid-response','Resource metadata could not be read')
  return { id: item.resource_key,name: item.data.name,description: item.data.description,group: typeof item.data.group === 'string' ? item.data.group : null,
    modifiedAt: typeof item.data.modifiedAt === 'string' ? item.data.modifiedAt : item.updated_at,path: item.resource_key,index: item.resource_key }
}
export function assistantPanelLibrary(panel: AssistantPanelFiles) {
  const volumeOf = (kind: UserLibraryKind, rows: AssistantPanelItem[]): UserLibraryRead => {
    const items = rows.map(metadata),volume = { kind,name: kind,path: kind,index: kind }
    return {volume,items,content:items.map(item=>`- ${item.name}：${item.description}`).join('\n')}
  }
  function localRows(kind: UserLibraryKind) {
    const snapshot=panel.peekSnapshot()
    if(!snapshot)return
    const collection=assistantPanelCollection(snapshot,domain(kind),panel.deviceId)
    return collection.state==='unprepared'&&!collection.items.length?undefined:collection.items
  }
  return {
    peekVolume(kind: UserLibraryKind): UserLibraryRead | undefined {
      try { const rows=localRows(kind);return rows?volumeOf(kind,rows):undefined } catch { return }
    },
    peekEntry(kind: UserLibraryKind,key:string): UserLibraryEntry | undefined {
      try {const row=localRows(kind)?.find(row=>row.resource_key===key);const bytes=row&&panel.peekBody(row)
        return row&&bytes?{...metadata(row),content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}:undefined
      } catch { return }
    },
    async volume(kind: UserLibraryKind): Promise<UserLibraryRead> {
      return volumeOf(kind,await panel.collection(domain(kind)))
    },
    async entry(kind: UserLibraryKind, key: string): Promise<UserLibraryEntry> {
      const item = (await panel.collection(domain(kind))).find(row => row.resource_key === key)
      if (!item) throw new AssistantPanelError('missing','The resource no longer exists')
      return { ...metadata(item),content: new TextDecoder('utf-8',{ fatal: true }).decode(await panel.body(item)) }
    },
    async save(change: UserLibraryWrite): Promise<UserLibraryEntry> {
      const collection = assistantPanelCollection(await panel.snapshot(),domain(change.kind),panel.deviceId)
      const existing = collection.items.find(row => row.resource_key === change.id)
      if (change.expectedModifiedAt && (!existing || metadata(existing).modifiedAt !== change.expectedModifiedAt)) throw new AssistantPanelError('40001','PANEL_RESOURCE_CHANGED')
      const id = change.id ?? crypto.randomUUID(), modifiedAt = new Date().toISOString()
      await panel.put(domain(change.kind),id,{ name: change.name,description: change.description,group: change.group,modifiedAt,contentFormat: 'markdown' },
        new TextEncoder().encode(change.content),existing?.revision ?? '0')
      return { ...change,id,modifiedAt,path: id,index: id }
    },
  }
}
