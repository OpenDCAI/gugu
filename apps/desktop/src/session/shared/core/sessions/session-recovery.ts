/** A missing engine session can be replaced only when its recorded first utterance can be replayed. */
export function canStartFreshSession(errorKind: string | null | undefined, firstUtterance: string | undefined): boolean {
  return errorKind === 'provider_session_missing' && Boolean(firstUtterance);
}
