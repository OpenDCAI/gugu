import type { EffortOptionDescriptor } from './capabilities/effort';

/**
 * The two capability slices this resolver reads. Declared structurally so both the plugin
 * definitions (`@gugu/session-core`) and the renderer DTOs (`AgentCapabilities`) satisfy it
 * without either side importing the other.
 */
export type EffortCapabilityShape =
  | { kind: 'selectable'; effortOptions: Record<string, EffortOptionDescriptor> }
  | { kind: string };

export type ModelsCapabilityShape =
  | {
      kind: 'selectable';
      modelOptions: Record<
        string,
        { effortIds?: string[]; defaultEffortId?: string; [key: string]: unknown }
      >;
    }
  | { kind: string };

export type ResolvedModelEfforts = {
  /** Levels this model accepts, in the order the plugin declared them. */
  options: Record<string, EffortOptionDescriptor>;
  /** Level to pre-select, or null when the plugin named no default. */
  defaultId: string | null;
};

/**
 * Resolve which effort levels apply to `modelId`, or null when effort is not offered here.
 *
 * Fail-closed by design — null (composer hides the control) rather than a guessed list:
 *   - agent declares no effort catalog
 *   - agent has no selectable models, or `modelId` is absent/unknown
 *   - the model declares no `effortIds` (e.g. Claude Code's haiku-4-5, which reports
 *     effort as unsupported, or a model newer than the pinned CLI catalog)
 *
 * Ids the catalog doesn't define are dropped here; `registry.test.ts` fails the build on
 * them, so a drop means a stale declaration rather than a runtime surprise.
 */
export function resolveModelEfforts(
  effort: EffortCapabilityShape | undefined,
  models: ModelsCapabilityShape | undefined,
  modelId: string | null | undefined
): ResolvedModelEfforts | null {
  if (!effort || effort.kind !== 'selectable') return null;
  if (!models || models.kind !== 'selectable') return null;
  if (!modelId) return null;

  const catalog = (effort as { effortOptions: Record<string, EffortOptionDescriptor> })
    .effortOptions;
  const model = (models as { modelOptions: Record<string, { effortIds?: string[]; defaultEffortId?: string }> })
    .modelOptions[modelId];
  if (!model?.effortIds?.length) return null;

  const options: Record<string, EffortOptionDescriptor> = {};
  for (const id of model.effortIds) {
    const option = catalog[id];
    if (option) options[id] = option;
  }
  if (Object.keys(options).length === 0) return null;

  const defaultId =
    model.defaultEffortId && options[model.defaultEffortId] ? model.defaultEffortId : null;
  return { options, defaultId };
}
