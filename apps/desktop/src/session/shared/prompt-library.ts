import z from 'zod';

export const promptLibraryPromptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
});

export const promptLibrarySchema = z.array(promptLibraryPromptSchema);

export type PromptLibraryPrompt = z.infer<typeof promptLibraryPromptSchema>;

export const PROMPT_LIBRARY_SEED_VERSION = 1;
