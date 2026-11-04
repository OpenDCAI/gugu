export type ClashMember = { id: string; type: 'human' | 'agent'; displayName: string; nameSerial: number | null }

/** Display-only disambiguation within one chat; the serial belongs to the identity. */
export function clashSuffixes(members: readonly ClashMember[]): Map<string, string> {
  const names = new Map<string, Set<string>>()
  for (const member of members) {
    const key = member.displayName.trim().toLowerCase()
    if (!key) continue
    const ids = names.get(key) ?? new Set<string>()
    ids.add(member.id)
    names.set(key, ids)
  }
  return new Map(members.flatMap((member) => member.type === 'agent' && member.nameSerial != null
    && (names.get(member.displayName.trim().toLowerCase())?.size ?? 0) > 1
    ? [[member.id, `#${member.nameSerial}`] as const] : []))
}
