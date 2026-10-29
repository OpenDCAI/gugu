/** Wire samples, independent of the patch reader/writer under test. */
export const filePatchFixtures = [
  {
    name: 'multiple separated hunks',
    block: {
      type: 'diff', changes: [{ operation: 'modify', path: '/work/source.ts', fileType: 'text', _meta: { revision: 2 } }],
      patch: { format: 'git_patch', text: 'diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -2,2 +2,2 @@\n context\n-before\n+after\n@@ -90 +90,2 @@\n-tail\n+new tail\n+extra\n\\ No newline at end of file\n' },
      _meta: { trace: 'original' },
    },
  },
  {
    name: 'rename with an authoritative destination',
    block: {
      type: 'diff', changes: [{ operation: 'move', oldPath: 'C:\\work\\old name.ts', path: 'C:\\work\\new name.ts', fileType: 'text' }],
      patch: { format: 'git_patch', text: 'diff --git "a/old name.ts" "b/new name.ts"\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts\n' },
    },
  },
  {
    name: 'binary with no invented text',
    block: {
      type: 'diff', changes: [{ operation: 'modify', path: '/work/icon.bin', fileType: 'binary', mimeType: 'application/octet-stream' }],
      patch: { format: 'git_patch', text: 'diff --git a/icon.bin b/icon.bin\nBinary files a/icon.bin and b/icon.bin differ\n' },
    },
  },
  {
    name: 'CRLF and no final newline',
    block: {
      type: 'diff', changes: [{ operation: 'modify', path: '/work/crlf.txt', fileType: 'text' }],
      patch: { format: 'git_patch', text: 'diff --git a/crlf.txt b/crlf.txt\r\n--- a/crlf.txt\r\n+++ b/crlf.txt\r\n@@ -1,2 +1,2 @@\r\n one\r\n-two\r\n+three\r\n\\ No newline at end of file\r\n' },
    },
  },
  {
    name: 'multiple operations including a missing renderable patch',
    block: {
      type: 'diff', changes: [{ operation: 'add', path: '/work/a' }, { operation: 'copy', oldPath: '/work/a', path: '/work/b' }, { operation: 'delete', path: '/work/c' }],
      patch: null,
    },
  },
  {
    name: 'future operations and patch formats retain their bytes',
    block: { type: 'diff', changes: [{ operation: '_metadata', path: '/work/a', custom: { mode: 'executable' } }], patch: { format: '_opaque', text: 'provider-owned\r\nbytes' }, _meta: { future: null } },
  },
] as const;
