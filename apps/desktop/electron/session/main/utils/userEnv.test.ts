import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ensureUserBinDirsInPath } from './userEnv';

let root = '';
let savedPath: string | undefined;
const entries = () => (process.env.PATH ?? '').split(path.delimiter);
beforeEach(async () => {
  savedPath = process.env.PATH;
  root = await mkdtemp(path.join(os.tmpdir(), 'user-env-'));
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(root, { recursive: true, force: true });
});

// #935 干净 profile 上 mise-bin 要到第一次发布启动器才建出来:它必须从启动起就在 PATH 最前。
it('puts the managed launcher directory first exactly once, before it exists and after later re-primes', async () => {
  const managed = path.join(root, 'mise-bin');
  const system = path.join(root, 'system');
  process.env.PATH = [system, managed].join(path.delimiter);

  ensureUserBinDirsInPath([managed], []);
  expect(entries()).toEqual([managed, system]);

  await mkdir(managed);
  ensureUserBinDirsInPath([managed], []);
  ensureUserBinDirsInPath([managed], []);
  expect(entries()).toEqual([managed, system]);
});

it('adds user-owned directories only when they exist', async () => {
  const managed = path.join(root, 'mise-bin');
  const present = path.join(root, 'local-bin');
  const absent = path.join(root, 'absent-bin');
  const vendorAbsent = path.join(root, 'vendor-bin');
  await mkdir(present);
  process.env.PATH = path.join(root, 'system');

  ensureUserBinDirsInPath([managed, absent, present], [vendorAbsent]);
  expect(entries()).toEqual([managed, present, path.join(root, 'system')]);
});
