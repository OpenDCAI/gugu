// @@@fcp - MEASUREMENT PROBE ONLY (lane/fast-create-measure); never merge. One JSON line per stage:
// node processes append to $TMPDIR/fcp.log; the renderer prints `[fcp] {...}` to its console (read over CDP).
export function fcp(stage: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: Date.now(), s: stage, ...(extra ?? {}) });
  const p = (globalThis as { process?: { pid?: number; getBuiltinModule?: (m: string) => any; env?: Record<string, string | undefined> } }).process;
  const fs = p?.getBuiltinModule?.('node:fs');
  if (fs && p) {
    const os = p.getBuiltinModule!('node:os');
    try { fs.appendFileSync(`${p.env?.FCP_LOG ?? os.tmpdir() + '/fcp.log'}`, line.replace(/^\{/, `{"pid":${p.pid},`) + '\n'); } catch { /* probe */ }
    return;
  }
  console.log('[fcp] ' + line);
}
