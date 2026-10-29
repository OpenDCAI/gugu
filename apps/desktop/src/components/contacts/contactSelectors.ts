import type { ContactUser } from '@gugu/core/shared/types/contacts'

/** Friends and the human address book share the same people-only boundary. */
export function peopleContacts(contacts: readonly ContactUser[]): ContactUser[] {
  return contacts.filter(contact => contact.type !== 'agent')
}

/** Agent library: registered contacts plus agents encountered in shared groups, once per ID. */
export function contactAgents(contacts: readonly ContactUser[], sharedGroupAgents: readonly ContactUser[]): ContactUser[] {
  const byId = new Map<string, ContactUser>()
  for (const contact of contacts) if (contact.type === 'agent') byId.set(contact.id, contact)
  for (const agent of sharedGroupAgents) byId.set(agent.id, agent)
  return [...byId.values()]
}
