import { describe, expect, it } from 'vitest';
import { WORKSPACE_TEXT_MAX_BYTES, workspaceStoredText, workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs';

describe('workspace text classification', () => {
  it('uses the upload rule for new documents and keeps larger historical text readable', () => {
    const text = `# Note\n${'x'.repeat(WORKSPACE_TEXT_MAX_BYTES)}`;
    const bytes = new TextEncoder().encode(text);

    expect(workspaceUploadKind('note.md', 'application/octet-stream', bytes)).toMatchObject({ kind: 'file' });
    expect(workspaceStoredText('note.md', 'application/octet-stream', bytes)).toEqual({ contentType: 'text/markdown', text });
  });

  it('treats source files as collaborative text when their suffix names a text MIME type', () => {
    expect(workspaceUploadKind('server.ts', 'application/octet-stream', new TextEncoder().encode('export const answer = 42;')))
      .toEqual({ kind: 'document', contentType: 'text/typescript', text: 'export const answer = 42;' });
  });

  it('uses the same document rule for JSON objects and CSV files', () => {
    expect(workspaceUploadKind('board.json', 'application/octet-stream', new TextEncoder().encode('{"ok":true}')))
      .toEqual({ kind: 'document', contentType: 'application/json', text: '{"ok":true}' });
    expect(workspaceUploadKind('rows.csv', 'application/octet-stream', new TextEncoder().encode('name,count\nAda,1\n')))
      .toEqual({ kind: 'document', contentType: 'text/csv', text: 'name,count\nAda,1\n' });
  });

  it('does not preview binary bytes or text-like files with invalid UTF-8', () => {
    expect(workspaceStoredText('scan.png', 'image/png', new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(workspaceStoredText('notes.md', 'text/markdown', new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
  });
});
