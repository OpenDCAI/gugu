import { describe, expect, it } from 'vitest';
import { composerDrafts } from './composer-drafts';
import type { ComposerAttachmentDraft } from './composer-attachment-draft';

describe('creation draft handoff', () => {
  it('moves the edited first turn back without a stale copy replacing it', () => {
    composerDrafts.set('handoff-home', '最初的首句');
    composerDrafts.moveToEmpty('handoff-home', 'handoff-project');
    expect(composerDrafts.get('handoff-home')).toBe('');
    composerDrafts.set('handoff-project', '在项目里改过的首句');
    composerDrafts.moveToEmpty('handoff-project', 'handoff-home');
    expect(composerDrafts.get('handoff-home')).toBe('在项目里改过的首句');
    expect(composerDrafts.get('handoff-project')).toBe('');
  });

  it('moves attachment-only drafts with their original bytes, then consumes the handoff', () => {
    const snapshot: ComposerAttachmentDraft = {
      uploads: [{
        chip: { id: 'attachment', name: 'note.txt', kind: 'file' },
        source: { kind: 'file', name: 'note.txt', size: 3, slice: async () => new Uint8Array([1, 2, 3]) },
      }],
    };
    const unregister = composerDrafts.registerAttachments('attachment-home', () => snapshot);
    composerDrafts.moveToEmpty('attachment-home', 'attachment-project');
    unregister();
    expect(composerDrafts.attachments('attachment-home')).toBeUndefined();
    expect(composerDrafts.attachments('attachment-project')).toBe(snapshot);
    composerDrafts.consumeAttachments('attachment-project');
    expect(composerDrafts.attachments('attachment-project')).toBeUndefined();
  });

  it('keeps both drafts when the destination already has unsent text', () => {
    composerDrafts.set('occupied-home', '全局首句');
    composerDrafts.set('occupied-project', '项目已有首句');
    composerDrafts.moveToEmpty('occupied-home', 'occupied-project');
    expect(composerDrafts.get('occupied-home')).toBe('全局首句');
    expect(composerDrafts.get('occupied-project')).toBe('项目已有首句');
  });
});
