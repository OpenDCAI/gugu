import { z } from 'zod';
import { promptAttachmentSchema } from './attachments';
export type { PromptAttachment } from './attachments';

export const promptInputSchema = z.object({
  text: z.string(),
  hiddenContext: z.string().optional(),
  attachments: z.array(promptAttachmentSchema).optional(),
  /**
   * Where this message came from.
   *
   * `manual` is reserved for text the user enters in the session-page composer. `typed` marks other
   * text sent verbatim into this session. `communication` marks a session-page delivery envelope.
   *
   * Ordinary session-direct messages are injected synchronously by the host; startup delegation and
   * legacy pending rows may still be projected through the durable inbox reader. This prompt model
   * remains transport-agnostic and never owns dequeue or merge behavior.
   */
  origin: z.enum(['manual', 'typed', 'communication']).optional(),
  /**
   * #6387 While this prompt waits in the queue, a newer prompt with the same key replaces it in place
   * — an extension turning a stream of interactions into messages sends only the latest state, not
   * one turn per click. Only a prompt still waiting is replaced; one already sent is history.
   */
  coalesceKey: z.string().optional(),
  /** When the person sent it: the one clock origin of the turn it opens, whatever it waited for before. */
  sentAt: z.number().optional(),
  /** Runtime admission intent retained while waiting; absent entries keep next-turn semantics. */
  queueTiming: z.literal('next-tool-call').optional(),
});
export type PromptInput = z.infer<typeof promptInputSchema>;

export const promptDraftInputSchema = promptInputSchema.extend({
  /** Monotonic writer revision used by clients to suppress stale draft echoes. */
  rev: z.number(),
});
export type PromptDraftInput = z.infer<typeof promptDraftInputSchema>;

export const promptDraftSchema = promptDraftInputSchema.extend({
  /** Epoch ms when the runtime last accepted this draft revision. */
  updatedAt: z.number(),
});
export type PromptDraft = z.infer<typeof promptDraftSchema>;

export const promptDraftUpdateSchema = z.object({
  /** Monotonic writer revision used to ignore stale draft updates, including clears. */
  rev: z.number(),
  input: promptInputSchema.nullable(),
});
export type PromptDraftUpdate = z.infer<typeof promptDraftUpdateSchema>;

/** A reserved queue entry being edited in the main composer; it cannot drain. */
export const queuedPromptEditSchema = z.object({
  draftText: z.string(),
  originalDraftText: z.string(),
});
export type QueuedPromptEdit = z.infer<typeof queuedPromptEditSchema>;

export const queuedPromptSchema = promptInputSchema.extend({
  /** Runtime-generated id used for queue removal and stable UI keys. */
  id: z.string(),
  /** Epoch ms when this prompt entered the runtime queue/model. */
  createdAt: z.number(),
  /** Epoch ms when queued prompt content or attachments were last edited. */
  updatedAt: z.number(),
  queueEdit: queuedPromptEditSchema.optional(),
  /** Runtime-only reservation until the provider returns its admission receipt. */
  queueDispatching: z.literal(true).optional(),
});
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;
