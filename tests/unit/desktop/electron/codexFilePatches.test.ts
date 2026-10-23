import { expect, it } from 'vitest';
import { codexFilePatches } from '../../../../apps/desktop/electron/runtime/codex-file-changes.mjs';

it('preserves every supplied update hunk byte and the native Windows destination', () => {
  const diff = '@@ -2 +2 @@\r\n-old\r\n+new\r\n@@ -80 +80 @@\r\n-a\r\n+b\r\n\\ No newline at end of file\r\n';
  const item = { changes: [{ path: 'C:\\work\\old.ts', kind: { type: 'update' as const, move_path: 'C:\\work\\new.ts' }, diff }] };
  const [patch] = codexFilePatches(item);
  expect(patch).toMatchObject({ changes: [{ operation: 'move', oldPath: 'C:\\work\\old.ts', path: 'C:\\work\\new.ts' }], scope: 'file' });
  expect(patch.patch!.text.endsWith(diff)).toBe(true);
});

it('keeps an already complete native patch, including binary and rename metadata', () => {
  for (const diff of [
    'diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n',
    'diff --git a/icon b/icon\nBinary files a/icon and b/icon differ\n',
  ]) {
    expect(codexFilePatches({ changes: [{ path: '/work/icon', kind: { type: 'update', move_path: null }, diff }] })[0]!.patch!.text).toBe(diff);
  }
});

it('converts full create/delete text once, retaining CRLF and EOF facts', () => {
  const [created, deleted] = codexFilePatches({ changes: [
    { path: '/work/a', kind: { type: 'add' }, diff: 'one\r\ntwo' },
    { path: '/work/b', kind: { type: 'delete' }, diff: 'one\r\ntwo\r\n' },
  ] });
  expect(created).toMatchObject({ changes: [{ operation: 'add', path: '/work/a' }], scope: 'file' });
  expect(created.patch!.text).toContain('+one\r\n+two\n\\ No newline at end of file\n');
  expect(deleted).toMatchObject({ changes: [{ operation: 'delete', path: '/work/b' }], scope: 'file' });
  expect(deleted.patch!.text).toContain('-one\r\n-two\r\n');
  expect(deleted.patch!.text).not.toContain('No newline');
});
