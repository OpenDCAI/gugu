import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { prepareLocalAssistantHome } from '../../../../apps/desktop/electron/assistant-home-prepare';
import { createWorkspaceUploads, readWorkspaceChunk } from '../../../../apps/desktop/electron/session/main/core/files/workspace-transfer';
import { assistantHomePaths } from '../../../../packages/core/src/shared/assistantPolicy';
import { composeInstructions, splitInstructions } from '../../../../packages/core/src/shared/assistantInstructions';
import type { HomeFs } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move-copy';
import { runMove, type MoveDeps, type MoveJournal, type MoveSide } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hasCode = (error: unknown, code: string) => (error as { code?: string } | null)?.code === code;

// Use the native upload version checks and real home preparation, including regenerated managed instructions.
function nativeFs(root: string): HomeFs {
  const upload = createWorkspaceUploads();
  const fs: HomeFs = {
    async list(dir) {
      try {
        return await Promise.all((await readdir(dir)).map(async name => {
          const stat = await lstat(join(dir, name));
          return { name, type: stat.isSymbolicLink() ? 'symlink' as const : stat.isDirectory() ? 'directory' as const : 'file' as const,
            size: stat.size, mtime: stat.mtimeMs };
        }));
      } catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    },
    async revision(path) {
      try { return (await readWorkspaceChunk(root, { path, offset: 0, length: 0 })).etag; }
      catch (error) { if (hasCode(error, 'not_found')) return null; throw error; }
    },
    async readChunk(path, offset, length) {
      return new Uint8Array(Buffer.from((await readWorkspaceChunk(root, { path, offset, length })).data, 'base64'));
    },
    async writeChunk({ path, uploadId, offset, data, total, final, expectedRevision }) {
      const result = await upload.write(root, { path, uploadId, offset, data: Buffer.from(data).toString('base64'),
        total, final, expectedEtag: expectedRevision ?? null });
      return result.committed ? { size: result.committed.size } : null;
    },
    async makeDir(parent, name) { await mkdir(join(parent, name), { recursive: true }); },
    async readText(path) {
      try { return await readFile(path, 'utf8'); }
      catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    },
    async writeText(path, content, expectedRevision) {
      const data = new TextEncoder().encode(content);
      await fs.writeChunk({ path, uploadId: crypto.randomUUID(), offset: 0, data, total: data.length, final: true, expectedRevision });
    },
  };
  return fs;
}

function side(root: string, instructions: string, deviceId: string): MoveSide {
  return { label: deviceId, deviceId, workdir: root, base: root, fs: nativeFs(root),
    paths: { instructions, memoryDir: join(root, 'memory'), skillsDir: join(root, 'skills'), resourcesDir: join(root, 'resources') },
    integrations: { exportForMove: async () => ({ accounts: [], skipped: [] }), importFromMove: async () => ({ imported: 0, skipped: [] }),
      accountIds: async () => [], disconnect: async () => {} },
    schedules: { list: async () => [], restore: async () => ({ restored: 0, skipped: [] }) } };
}

it('resumes cloud-to-computer after preserving conflicting instructions and moving them aside', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-move-recovery-'));
  roots.push(root);
  const home = join(root, 'home'), guguHome = join(root, 'gugu'), sourceRoot = join(root, 'source');
  await mkdir(home); await mkdir(sourceRoot);
  const prepared = await prepareLocalAssistantHome({}, { home, guguHome });
  const instructions = assistantHomePaths(home, prepared.workdir, 'computer').instructions;
  const sourcePath = join(sourceRoot, 'CLAUDE.md');
  await writeFile(sourcePath, 'CURRENT-CLOUD-USER\n');
  const source = side(sourceRoot, sourcePath, 'cloud');
  source.schedules.list = async () => [{ name: 'daily', prompt: 'hello', triggerConfig: { expr: '0 9 * * *' }, enabled: true }];
  const target = side(prepared.workdir, instructions, 'local');
  let restoreFails = true, adopted = false;
  target.schedules.restore = async () => {
    if (restoreFails) throw new Error('interrupted before schedule handoff');
    return { restored: 1, skipped: [] };
  };
  let journal: MoveJournal | null = null;
  const deps: MoveDeps = { direction: 'to-computer', assistantId: 'agent', source, sourceHome: { kind: 'cloud', deviceId: 'cloud' },
    journal: { load: () => journal, save: value => { journal = structuredClone(value); }, clear: () => { journal = null; } },
    isAdopted: async () => adopted, adopt: async () => { adopted = true; },
    openTarget: async () => { await prepareLocalAssistantHome({}, { home, guguHome }); return target; }, restart: vi.fn(async () => {}) };
  await expect(runMove(deps)).rejects.toMatchObject({ step: 'schedules' });
  expect(splitInstructions(await readFile(instructions, 'utf8')).user).toBe('CURRENT-CLOUD-USER');
  restoreFails = false;
  await writeFile(instructions, composeInstructions(await readFile(instructions, 'utf8'), 'NEW-AT-TARGET'));
  await expect(runMove(deps)).rejects.toMatchObject({ step: 'files', cause: { code: 'conflict' } });
  expect(deps.restart).not.toHaveBeenCalled();
  const preserved = `${instructions}.saved`;
  await rename(instructions, preserved); // The recovery action displayed by the move UI.
  await expect(runMove(deps)).resolves.toMatchObject({ schedules: { restored: 1 } });
  const recovered = splitInstructions(await readFile(instructions, 'utf8'));
  expect(recovered.user).toBe('CURRENT-CLOUD-USER');
  expect(recovered.managed).toContain('<!-- 咕咕管家');
  expect(splitInstructions(await readFile(preserved, 'utf8')).user).toBe('NEW-AT-TARGET');
  expect(await readFile(sourcePath, 'utf8')).toBe('CURRENT-CLOUD-USER\n');
  expect(deps.restart).toHaveBeenCalledTimes(1);
  expect(journal).toBeNull();
});
