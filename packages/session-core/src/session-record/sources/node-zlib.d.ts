import 'node:zlib';
import type { Transform } from 'node:stream';

// The repository uses @types/node 20; Electron 44 / Node 24 provide these zstd APIs at runtime.
// Declare only the two signatures this reader and its tests use, without widening the repository's Node types.
declare module 'node:zlib' {
  export function createZstdDecompress(): Transform;
  export function zstdCompressSync(buffer: Uint8Array): Buffer;
}
