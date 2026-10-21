import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_APP_DATA_FILE_BYTES as MAX_EXTENSION_DATA_FILE_BYTES } from '@shared/extensions/app-data';
import {
  extensionDataDir,
  listExtensionData,
  readExtensionData,
  removeExtensionData,
  writeExtensionData,
} from './extension-data';

/**
 * #6387 The folder an extension's pages and its MCP programs share: what an agent writes
 * through the program is what the person sees in the tab.
 */

function freshRoot(): string {
  return extensionDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-6387-data-')), 'agent-notes');
}

describe('extension data folder (#6387)', () => {
  it('reads back what was written; an unwritten file is empty, not an error', () => {
    const root = freshRoot();
    expect(readExtensionData(root, 'notes.json')).toBeNull();
    writeExtensionData(root, 'notes/2026.json', '[1]');
    expect(readExtensionData(root, 'notes/2026.json')).toBe('[1]');
    expect(listExtensionData(root, '')).toEqual([{ path: 'notes', kind: 'directory' }]);
    expect(listExtensionData(root, 'notes')).toEqual([{ path: 'notes/2026.json', kind: 'file' }]);
    // 原子写:目录里不留临时文件。
    expect(fs.readdirSync(path.join(root, 'notes'))).toEqual(['2026.json']);
  });

  it('never leaves the folder and refuses oversized files', () => {
    const root = freshRoot();
    expect(() => readExtensionData(root, '../other/secret')).toThrow(/inside the App's data folder/);
    expect(() => writeExtensionData(root, '/etc/x', 'x')).toThrow(/inside the App's data folder/);
    expect(() => writeExtensionData(root, '', 'x')).toThrow(/must name a file/);
    expect(() => writeExtensionData(root, 'big', 'x'.repeat(MAX_EXTENSION_DATA_FILE_BYTES + 1))).toThrow(/larger than/);
  });

  it('goes away with the extension', () => {
    const root = freshRoot();
    writeExtensionData(root, 'notes.json', '[]');
    removeExtensionData(root);
    expect(fs.existsSync(root)).toBe(false);
  });
});
