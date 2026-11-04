import { writeSync } from 'node:fs';

/** Logging must not fail the caller when the host closes its output pipe. */
export function writeLogSync(fd: number, line: string): void {
  try {
    writeSync(fd, line);
  } catch {
    // A closed/full output must not turn logging into a process failure.
  }
}
