import { expect, it } from 'vitest';
import { editQueuedPromptCommandSchema } from '../api/commands';
import { queuedPromptSchema } from './prompt';

it('keeps the main-composer reservation across command and state validation', () => {
  const queueEdit = { draftText: 'editing', originalDraftText: 'original main draft' };
  expect(editQueuedPromptCommandSchema.parse({ sessionId: 's', id: 'q', input: { text: 'committed' }, queueEdit }).queueEdit).toEqual(queueEdit);
  expect(queuedPromptSchema.parse({ id: 'q', text: 'committed', createdAt: 1, updatedAt: 2, queueEdit }).queueEdit).toEqual(queueEdit);
  expect(editQueuedPromptCommandSchema.parse({ sessionId: 's', id: 'q', input: { text: 'saved' }, queueEdit: null }).queueEdit).toBeNull();
  expect(editQueuedPromptCommandSchema.parse({ sessionId: 's', id: 'q', input: { text: 'legacy edit' } }).queueEdit).toBeUndefined();
});
