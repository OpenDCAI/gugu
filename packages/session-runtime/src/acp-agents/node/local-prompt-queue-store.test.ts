import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalPromptQueueStore } from './local-prompt-queue-store';

it('persists the committed queue entry without an edit reservation or a private composer draft', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-queue-edit-'));
  try {
    const store = new LocalPromptQueueStore(root);
    store.save('session', [{ id: 'same-id', createdAt: 1, updatedAt: 2, text: 'committed', origin: 'manual',
      queueEdit: { draftText: 'unsaved edit', originalDraftText: 'private original draft' } }]);
    const raw = readFileSync(join(root, 'session.json'), 'utf8');
    expect(raw).not.toContain('unsaved edit');
    expect(raw).not.toContain('private original draft');
    expect(raw).not.toContain('queueEdit');
    expect(store.load('session')).toEqual([{ text: 'committed', origin: 'manual' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
