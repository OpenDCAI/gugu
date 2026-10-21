export interface RosterNameMember {
  id: string
  name: string
  type: 'human' | 'agent'
}

export interface RosterDirectoryMember {
  id: string
  display_name?: string | null
  type?: string | null
}

export interface RosterNameHit {
  name: string
  ids: string[]
}

export interface RosterNameIndexEntry {
  name: string
  characters: string[]
  memberIds: string[]
  agentIds: string[]
  ascii: boolean
}

export function findRosterNameHits(users: RosterDirectoryMember[], content: unknown): RosterNameHit[]
export function buildRosterNameIndex(members: RosterNameMember[]): RosterNameIndexEntry[]
export function resolveOpeningAgentCall(index: RosterNameIndexEntry[], content: unknown): string[]
