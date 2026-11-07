Run with the repository's pinned Node version:

```sh
node scripts/benchmarks/timeline-archive/run.mjs dff8b960 /tmp/timeline-archive-results.json
```

The runner bundles the real source readers, timeline and disk archive store at
the baseline revision and the current working tree. Only Electron's userData
path and the logger are substituted. Fixtures contain generated Claude/Codex
messages with ASCII, Chinese, emoji and escapes, padded to exact source sizes.
Both application data paths are isolated; no user transcripts or services are used.

Both revisions run in the same process against the same fixture, alternating
which runs first. There are three warmups and 40 measured pairs per case
(`GUGU_BENCH_ROUNDS` overrides this).
Reopen includes stat/read/parse, source resume, reducer restoration and the first
snapshot. It runs the same archive/dispose/save operations as the 60-second idle
callback, excluding the timer wait. Every reopen asserts that no full transcript
replay occurred and that its visible turns equal the initial snapshot.

Stringify/parse are measured separately, collecting garbage outside each timed
operation. Reopen also collects before timing to avoid carrying the encoding
probe's temporary objects into its measurement. Results contain every sample,
including outliers; report median, p95 and maximum rather than only the fastest.
The runner stops below 16 GiB free and removes only its own synthetic directory.
