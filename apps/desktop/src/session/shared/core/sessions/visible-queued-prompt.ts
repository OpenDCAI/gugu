import type { QueuedPrompt } from '@gugu/session-core/acp/client';

export function isVisibleQueuedPrompt(
  prompt: QueuedPrompt,
): prompt is QueuedPrompt & { origin: 'manual' | 'typed' } {
  if (!prompt.origin) {
    throw new Error(`Queued prompt ${prompt.id} has no explicit origin`);
  }
  return prompt.origin !== 'communication';
}
