import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStateFile, writeStateFile } from '../../../../apps/desktop/electron/app-state';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('app-state file', () => {
  it('reads a corrupt or non-object file as empty instead of blocking startup', () => {
    const file = join(dir, 'app-state.json');
    expect(readStateFile(file)).toEqual({});
    writeFileSync(file, '{"windowTone":');
    expect(readStateFile(file)).toEqual({});
    writeFileSync(file, 'null');
    expect(readStateFile(file)).toEqual({});
  });

  it('round-trips and never leaves its temp file behind', () => {
    const file = join(dir, 'app-state.json');
    writeStateFile(file, { windowTone: 'dark' });
    expect(readStateFile(file)).toEqual({ windowTone: 'dark' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ windowTone: 'dark' });
    expect(readdirSync(dir)).toEqual(['app-state.json']);
  });
});
