import { StringDecoder } from 'node:string_decoder';
import { TERMINAL_OUTPUT_BYTE_LIMIT } from '@gugu/session-core/acp';

export interface TerminalOutputArchive {
  seed(sessionId: string, terminalId: string, data: Uint8Array): void;
  size(sessionId: string, terminalId: string): number;
  append(sessionId: string, terminalId: string, data: Uint8Array): void;
  reset(sessionId: string, terminalId: string): void;
  read(
    sessionId: string,
    terminalId: string,
    offset: number,
    limit: number,
  ): { data: string; nextOffset: number; bytes: number };
}

/** Each decoded chunk enters the live window once. Old chunks leave without copying their neighbours. */
export class TerminalOutput {
  private decoder = new StringDecoder('utf8');
  private nextId = 0;
  private retained = 0;
  private readonly chunks = new Map<string, { text: string; bytes: number }>();
  private cached: Record<string, string> | undefined;
  bytes = 0;
  truncated = false;
  streamed = false;

  constructor(private readonly limit = TERMINAL_OUTPUT_BYTE_LIMIT) {}

  append(data: Buffer): void {
    this.bytes += data.length;
    this.streamed = true;
    // Bound individual wire patches even if a provider sends one very large delta.
    for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      this.add(this.decoder.write(data.subarray(offset, offset + 16 * 1024)));
    }
  }

  finish(): void {
    this.add(this.decoder.end());
  }

  reset(data: Buffer): void {
    this.decoder = new StringDecoder('utf8');
    this.chunks.clear();
    this.retained = 0;
    this.bytes = 0;
    this.truncated = false;
    this.cached = undefined;
    // Do not reuse chunk ids: a replacement must invalidate the previous replica's chunks.
    this.append(data);
    this.streamed = false;
  }

  private add(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    this.chunks.set(String(this.nextId++), { text, bytes });
    this.retained += bytes;
    while (this.retained > this.limit && this.chunks.size) {
      const key = this.chunks.keys().next().value!;
      this.retained -= this.chunks.get(key)!.bytes;
      this.chunks.delete(key);
      this.truncated = true;
    }
    this.cached = undefined;
  }

  snapshot(): Record<string, string> {
    return (this.cached ??= Object.fromEntries(
      [...this.chunks].map(([key, chunk]) => [key, chunk.text]),
    ));
  }

  get retainedBytes(): number {
    return this.retained;
  }

  text(limit = this.limit): string {
    const selected: string[] = [];
    let bytes = 0;
    for (const chunk of [...this.chunks.values()].reverse()) {
      if (bytes + chunk.bytes > limit) break;
      bytes += chunk.bytes;
      selected.push(chunk.text);
    }
    return selected.reverse().join('');
  }
}
