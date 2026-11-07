import assert from 'node:assert/strict';
import { mkdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import * as old from './old.mjs';
import * as current from './new.mjs';

const dir = process.argv[2];
const rounds = Number(process.argv[3]);
const versions = [{ mode: 'old', api: old, results: [] }, { mode: 'new', api: current, results: [] }];
await mkdir(dir, { recursive: true });
for (const harness of ['claude', 'codex']) for (const mib of [2, 7, Number(process.env.GUGU_BENCH_CAP_MIB ?? 7.5)]) {
  const disk = await statfs(dir);
  assert.ok(disk.bavail * disk.bsize >= 16 * 1024 ** 3, 'Free disk below 16 GiB');
  const root = await old.fixture(harness, mib * 1024 * 1024);
  const sessionId = `${harness}-${String(mib).replace('.', '-')}`;
  const cases = [];
  for (const version of versions) {
    const coldStart = performance.now();
    const timeline = await version.api.open(harness, root, sessionId);
    const coldMs = performance.now() - coldStart;
    assert.ok(timeline.getSnapshot().turns.length > 0);
    cases.push({ version, timeline, snapshot: JSON.stringify(timeline.getSnapshot({ limit: 20 }).turns),
      coldMs, reopenMs: [], disposeMs: [], stringifyMs: [], parseMs: [] });
  }
  for (let trial = -3; trial < rounds; trial++) {
    // Pair both revisions against the same fixture/process, alternating which
    // goes first to control filesystem, heap, JIT and thermal drift.
    for (const one of trial % 2 ? cases : [...cases].reverse()) {
      process.env.GUGU_HOME = join(dir, one.version.mode, 'home');
      process.env.GUGU_USER_DATA_DIR = join(dir, one.version.mode, 'user-data');
      const disposing = performance.now();
      // Same operations as the service's 60 s idle callback; omit only the wait.
      const pending = one.timeline.archive();
      one.timeline.dispose();
      const archive = await pending;
      assert.ok(archive, `${harness} ${mib} MiB must pass admission`);
      await one.version.api.saveTimelineArchive(sessionId, archive);
      const disposal = performance.now() - disposing;
      globalThis.gc();
      const reads = one.version.api.fullReadCount();
      const reopening = performance.now();
      const loaded = await one.version.api.loadTimelineArchive(sessionId);
      assert.ok(loaded, 'A missing cache cannot count as a cache hit');
      one.timeline = await one.version.api.open(harness, root, sessionId, loaded);
      one.timeline.getSnapshot({ limit: 20 });
      const elapsed = performance.now() - reopening;
      assert.equal(one.version.api.fullReadCount(), reads, 'Reopen must not replay the transcript');
      assert.equal(JSON.stringify(one.timeline.getSnapshot({ limit: 20 }).turns), one.snapshot);
      if (trial >= 0) { one.reopenMs.push(elapsed); one.disposeMs.push(disposal); }
    }
  }
  for (const one of cases) one.archive = await one.timeline.archive();
  for (let trial = -3; trial < rounds; trial++) {
    for (const one of trial % 2 ? cases : [...cases].reverse()) {
      globalThis.gc();
      const t0 = performance.now();
      const json = JSON.stringify(one.archive);
      const t1 = performance.now();
      globalThis.gc();
      const t2 = performance.now();
      JSON.parse(json);
      const t3 = performance.now();
      one.archiveBytes = Buffer.byteLength(json);
      if (trial >= 0) { one.stringifyMs.push(t1 - t0); one.parseMs.push(t3 - t2); }
    }
  }
  for (const one of cases) {
    one.timeline.dispose();
    const { coldMs, archiveBytes, reopenMs, disposeMs, stringifyMs, parseMs } = one;
    one.version.results.push({ harness, sourceMiB: mib, coldMs, archiveBytes, reopenMs, disposeMs, stringifyMs, parseMs });
  }
}
console.log(JSON.stringify(versions.map(({ mode, results }) => ({ mode, results }))));
