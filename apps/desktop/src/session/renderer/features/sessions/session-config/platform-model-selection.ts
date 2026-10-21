import { platformModelIdFromRuntimeOption } from '@/session/shared/platform-model-id';

export type PersistedSessionSelection = { modelId: string } | null | undefined;

/** 会话的计费路三态:`{modelId}` = 咕咕代付,`null` = 明确用自己的凭据,缺席 = 没做过这个决定。 */
export function sessionBillingRoute(selection: PersistedSessionSelection): 'platform' | 'own' | 'unknown' {
  return selection ? 'platform' : selection === null ? 'own' : 'unknown';
}

/**
 * The persisted conversation source decision is authoritative for the live composer.
 * `store.model` is the ACP adapter's transient report and can be empty while the
 * conversation selection is already known. Once a hot switch succeeds, the live
 * report is the newer platform model; the persisted choice remains the fallback
 * used during bootstrap and while Claude reports its pinned background model.
 */
export function runningPlatformModelId(
  sessionSelection: PersistedSessionSelection,
  liveModel?: string | null,
  platformModelIds?: readonly string[],
): string | null {
  if (!sessionSelection) return null;
  const known = platformModelIds ?? [];
  const liveCanonical = liveModel ? platformModelIdFromRuntimeOption(liveModel, known) : null;
  return liveCanonical
    || platformModelIdFromRuntimeOption(sessionSelection.modelId, known)
    || sessionSelection.modelId;
}
