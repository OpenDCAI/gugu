import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

export const modelOptionSchema = z.object({
  name: z.string(),
  /**
   * Compact label for tight spots — the composer's trigger and the settings panel's
   * 「模型」row, where the full name crowds out the effort level next to it. Codex shows
   * 「5.6 Sol」there while its list still reads「GPT-5.6 Sol」.
   *
   * Declared per model on purpose: there is no rule that turns a full name into a short one
   * across 34 harnesses ("GPT-5.6 Sol"→"5.6 Sol" but "Claude Opus 4.8"→? "Devstral Small"→?),
   * and a wrong guess produces a label nobody recognises. Omitted = use `name` unchanged.
   */
  shortName: z.string().optional(),
  description: z.string().optional(),
  modelFeatures: z
    .object({
      contextWindowSize: z.number().optional(),
      speed: z.number().min(1).max(5).optional(),
      intelligence: z.number().min(1).max(5).optional(),
    })
    .optional(),
  /**
   * Reasoning/effort levels *this model* accepts, in display order. Ids must exist in the
   * agent's `effort.effortOptions` catalog (enforced by `plugins/registry.test.ts`).
   *
   * Omitted = this model takes no effort setting, and the composer hides the control for it
   * rather than offering a level the CLI would reject. Deliberately not inherited from the
   * agent catalog: tiers differ per model (codex gpt-5.6-sol reaches `ultra`, gpt-5.5 stops
   * at `xhigh`; Claude Code reports effort unsupported for haiku-4-5), so a silent
   * agent-wide fallback would surface levels the model cannot honour.
   */
  effortIds: z.array(z.string()).optional(),
  /** Level pre-selected for this model. Must appear in `effortIds`. */
  defaultEffortId: z.string().optional(),
});

/**
 * ModelsDescriptor describes the models that an agent supports.
 *
 * kind: 'selectable' — the user can pick a model; modelOptions maps model ids to metadata
 * kind: 'none'       — the agent does not expose model selection
 */
export const modelsCapability = definePluginCapability()(
  'models',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('selectable'),
      defaultModelId: z.string().optional(),
      modelOptions: z.record(z.string(), modelOptionSchema),
      userAllowlist: z.object({ scope: z.literal('agent-home'), file: z.string().min(1), pointer: z.string().regex(/^\//), envVar: z.string().min(1).optional() }).strict().optional(),
    }),
    z.object({ kind: z.literal('none') }),
  ]),
  { kind: 'none' }
);
