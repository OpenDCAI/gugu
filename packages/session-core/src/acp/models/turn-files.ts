import { z } from 'zod';

/** A version in the task agent's DM folder. Local placement hints never belong in a task card. */
export const turnFileRefSchema = z.object({
  itemId: z.string().min(1),
  version: z.number().int().min(1),
  name: z.string().min(1),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  path: z.string().optional(),
  workspacePath: z.string().startsWith('.gugu/attachments/').optional(),
});
export type TurnFileRef = z.infer<typeof turnFileRefSchema>;
/** Human-visible/replay metadata: model context and host paths stay out of the transcript. */
export const transcriptFileRefSchema = turnFileRefSchema.omit({ path: true, workspacePath: true });
export const promptFileSchema = turnFileRefSchema.extend({ promptText: z.string().optional() });
