import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { moveClaudeHistoryToUserRoot } from './claude-history-move';

let dir = '';
let connection = '';
let native = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-claude-history-'));
  connection = join(dir, 'connection', '.claude');
  native = join(dir, 'user', '.claude');
  await mkdir(join(connection, 'projects', '-repo'), { recursive: true });
  await writeFile(join(connection, 'projects', '-repo', 'ran-on-connection.jsonl'), 'connection');
  await writeFile(join(connection, 'projects', '-repo', 'shared.jsonl'), 'connection copy');
  await mkdir(join(connection, 'todos'), { recursive: true });
  await writeFile(join(connection, 'todos', 'list.json'), '[]');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('copies what is missing, never overwrites the user root, and runs once per connection', async () => {
  await mkdir(join(native, 'projects', '-repo'), { recursive: true });
  await writeFile(join(native, 'projects', '-repo', 'shared.jsonl'), 'user copy');
  expect(await moveClaudeHistoryToUserRoot(connection, native)).toBe(true);
  expect(await readFile(join(native, 'projects', '-repo', 'ran-on-connection.jsonl'), 'utf8')).toBe('connection');
  expect(await readFile(join(native, 'projects', '-repo', 'shared.jsonl'), 'utf8')).toBe('user copy');
  expect(await readFile(join(native, 'todos', 'list.json'), 'utf8')).toBe('[]');

  await rm(join(native, 'projects', '-repo', 'ran-on-connection.jsonl'));
  expect(await moveClaudeHistoryToUserRoot(connection, native)).toBe(false);
  await expect(lstat(join(native, 'projects', '-repo', 'ran-on-connection.jsonl'))).rejects.toThrow();
});

it('copies through a user root whose projects folder, or one project in it, is a symlink, and keeps the links', async () => {
  const elsewhere = join(dir, 'elsewhere');
  await mkdir(join(elsewhere, 'projects'), { recursive: true });
  await mkdir(native, { recursive: true });
  await symlink(join(elsewhere, 'projects'), join(native, 'projects'));
  const project = join(dir, 'project-elsewhere');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'shared.jsonl'), 'user copy');
  await symlink(project, join(elsewhere, 'projects', '-repo'));

  expect(await moveClaudeHistoryToUserRoot(connection, native)).toBe(true);
  expect(await readFile(join(project, 'ran-on-connection.jsonl'), 'utf8')).toBe('connection');
  expect(await readFile(join(project, 'shared.jsonl'), 'utf8')).toBe('user copy');
  expect((await lstat(join(native, 'projects'))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(elsewhere, 'projects', '-repo'))).isSymbolicLink()).toBe(true);
});

it('skips links in the connection root that point back into the user root and still moves the rest', async () => {
  await mkdir(join(native, 'projects', '-repo', 'memory'), { recursive: true });
  await writeFile(join(native, 'projects', '-repo', 'memory', 'MEMORY.md'), 'user memory');
  await symlink(join(native, 'projects', '-repo', 'memory'), join(connection, 'projects', '-repo', 'memory'));
  await symlink(join(dir, 'gone'), join(connection, 'projects', '-repo', 'dangling'));

  expect(await moveClaudeHistoryToUserRoot(connection, native)).toBe(true);
  expect(await readFile(join(native, 'projects', '-repo', 'ran-on-connection.jsonl'), 'utf8')).toBe('connection');
  expect(await readFile(join(native, 'todos', 'list.json'), 'utf8')).toBe('[]');
  expect((await lstat(join(native, 'projects', '-repo', 'memory'))).isDirectory()).toBe(true);
  expect(await readFile(join(native, 'projects', '-repo', 'memory', 'MEMORY.md'), 'utf8')).toBe('user memory');
  await expect(lstat(join(native, 'projects', '-repo', 'dangling'))).rejects.toThrow();
  expect(await moveClaudeHistoryToUserRoot(connection, native)).toBe(false);
});

it('does nothing for a connection that never had a folder', async () => {
  expect(await moveClaudeHistoryToUserRoot(join(dir, 'missing', '.claude'), native)).toBe(false);
  await expect(lstat(native)).rejects.toThrow();
});
