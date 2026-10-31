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

it('preserves next-tool-call intent across restart but releases the process-local native reservation', () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-queue-timing-'));
  try {
    const store = new LocalPromptQueueStore(root);
    store.save('session', [
      { id: 'ordinary', text: 'ordinary', origin: 'communication', createdAt: 1, updatedAt: 1,
        queueTiming: 'next-tool-call', queueDispatching: true },
      { id: 'explicit', text: 'explicit queue', origin: 'communication', createdAt: 2, updatedAt: 2 },
    ]);
    expect(store.load('session')).toEqual([
      { text: 'ordinary', origin: 'communication', queueTiming: 'next-tool-call' },
      { text: 'explicit queue', origin: 'communication' },
    ]);
    expect(readFileSync(join(root, 'session.json'), 'utf8')).not.toContain('queueDispatching');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
