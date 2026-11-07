# Worker-owned window-cache primitives

Design and outstanding integration: [#2062](https://github.com/GUYI-AI/gugu/issues/2062), part of [#2007](https://github.com/GUYI-AI/gugu/issues/2007).

This directory is **not connected to production entry points**. It does not remove the existing archive admission limit or replace the provider decoders. No first-screen performance or constant total worker-memory result is claimed by these primitives alone.

- `byte-page.ts` reads one 64 KiB range at a generation-bound cursor. It returns bytes, including split UTF-8, split JSON and unterminated records; it does not pretend they form a complete turn. `file-source.ts` pins a descriptor and compares it with the current pathname before and after a read.
- `frame.ts` encodes one bounded payload with a fixed header, exact canonical identity/version metadata and a SHA-256 digest. A hit validates integrity and ownership; the worker must separately validate source freshness before publishing any result.
- `disk-frame.ts` publishes frames using a same-directory temporary file and atomic rename. Corrupt files and observable I/O failures produce typed misses. A writer error remains an error; the host decides how to report cache failure while continuing a bounded source read.
- `window-stream.ts` streams arbitrarily many frames and atomically publishes a constant-size root, without constructing an array of segment names. Each publication has a distinct namespace, so an incomplete writer cannot replace the previous root's frames. Readers pin a root and can fetch the last frame directly. The writer's staging allocation is bounded; the upstream worker producer must also use bounded chunks and spill history state to disk.

Payload frames are at most 64 KiB; a disk packet also has at most 4 KiB metadata and a 48-byte header. Memory retained by the cache does not include a history-sized manifest. Disk storage may grow with history; GC/pinning, the identity/dependency index, incremental oversized-record decoding, worker transport/packaging and real host/renderer integration are still required before activation. First-open provider identity/bootstrap remains the critical design risk described in the issue.

The tests use small temporary files or virtual 10/30/100/600 MiB offsets. Those virtual offsets test I/O bounds and cursor arithmetic, **not** reopen latency or memory on real transcripts. The separately assigned large-session benchmark supplies those measurements.
