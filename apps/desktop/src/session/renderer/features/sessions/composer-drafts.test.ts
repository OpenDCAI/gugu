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
      pending: [{ chip: { id: 'attachment', name: 'note.txt', kind: 'file' }, file: new File(['abc'], 'note.txt') }],
    };
    const draft = composerDrafts.forKey('attachment-home');
    draft.setPending(snapshot.pending);
    composerDrafts.moveToEmpty('attachment-home', 'attachment-project');
    expect(composerDrafts.forKey('attachment-project')).toBe(draft);
    expect(draft.pending).toBe(snapshot.pending);
    composerDrafts.forKey('attachment-project').take();
    expect(draft.pending).toEqual([]);
  });

  it('keeps both drafts when the destination already has unsent text', () => {
    composerDrafts.set('occupied-home', '全局首句');
    composerDrafts.set('occupied-project', '项目已有首句');
    composerDrafts.moveToEmpty('occupied-home', 'occupied-project');
    expect(composerDrafts.get('occupied-home')).toBe('全局首句');
    expect(composerDrafts.get('occupied-project')).toBe('项目已有首句');
  });
});
