import type { TokenEntry } from './token-readers/types';

/** Prefer one actual Claude snapshot, rather than manufacturing a request from bucket maxima. */
export function preferSnapshot(provider: string, candidate: TokenEntry, current: TokenEntry): boolean {
  if (provider !== 'claude' || !candidate.quality || !current.quality) return false;
  if (candidate.quality.complete !== current.quality.complete) return candidate.quality.complete;
  if (candidate.output !== current.output) return candidate.output > current.output;
  if (candidate.quality.fields !== current.quality.fields) return candidate.quality.fields > current.quality.fields;
  return candidate.input + candidate.output + candidate.cacheRead + candidate.cacheWrite
    > current.input + current.output + current.cacheRead + current.cacheWrite;
}
