import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TerminalOutputArchive } from '../runtime/terminal-output';

/** Synchronous bounded writes propagate disk pressure to the provider pipe instead of queuing output in RAM. */
export class LocalTerminalOutputArchive implements TerminalOutputArchive {
  private readonly sizes = new Map<string, number>();
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private file(sessionId: string, terminalId: string): string {
    const key = createHash('sha256')
      .update(JSON.stringify([sessionId, terminalId]))
      .digest('hex');
    return join(this.directory, `${key}.log`);
  }

  seed(sessionId: string, terminalId: string, data: Uint8Array): void {
    const file = this.file(sessionId, terminalId);
    try {
      writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.sizes.set(file, statSync(file).size);
  }

  size(sessionId: string, terminalId: string): number {
    return this.sizes.get(this.file(sessionId, terminalId)) ?? 0;
  }

  append(sessionId: string, terminalId: string, data: Uint8Array): void {
    const file = this.file(sessionId, terminalId);
    if (!this.sizes.has(file)) this.seed(sessionId, terminalId, new Uint8Array());
    appendFileSync(file, data, { mode: 0o600 });
    this.sizes.set(file, this.sizes.get(file)! + data.byteLength);
  }

  reset(sessionId: string, terminalId: string): void {
    const file = this.file(sessionId, terminalId);
    writeFileSync(file, '', { mode: 0o600 });
    this.sizes.set(file, 0);
  }

  read(sessionId: string, terminalId: string, offset: number, limit: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64 * 1024
    ) {
      throw new Error('Invalid terminal output page');
    }
    const fd = openSync(this.file(sessionId, terminalId), 'r');
    try {
      const bytes = fstatSync(fd).size;
      const data = Buffer.alloc(Math.min(limit, Math.max(0, bytes - offset)));
      const count = readSync(fd, data, 0, data.length, offset);
      return {
        data: data.subarray(0, count).toString('base64'),
        nextOffset: offset + count,
        bytes,
      };
    } finally {
      closeSync(fd);
    }
  }
}
