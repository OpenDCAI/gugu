import type { AssistantSetupDraft } from './assistantSetup'

type Checkpoint = { step: 'server'; draft: AssistantSetupDraft }
// Settings sections unmount independently. Keep the pre-install navigation draft
// in this renderer, scoped to its account; committed recovery uses the setup journal.
const checkpoints = new Map<string, Checkpoint>()
export function readAssistantOnboardingNavigation(ownerUserId: string): Checkpoint | null {
  return checkpoints.get(ownerUserId) ?? null
}
export function saveAssistantOnboardingNavigation(ownerUserId: string, draft: AssistantSetupDraft): void {
  checkpoints.set(ownerUserId, { step: 'server', draft })
}
export function clearAssistantOnboardingNavigation(ownerUserId: string): void {
  checkpoints.delete(ownerUserId)
}
