import { isMainThread } from 'node:worker_threads';
import { startProgramGugu, type ProgramChannel } from './program-host';

/**
 * `<runtime>/gugu-program.mjs` — `gugu` in an App's MCP program (F16, 真源 §4): the same global a page has,
 * started by main with `node --import <this>`, before the App's own code. Its host is main, over the child's
 * IPC channel (the fourth stdio slot, `serialization: 'advanced'`) — never the program's stdin / stdout,
 * which are the App's MCP server's own (`program-host.ts`).
 *
 * What a program has: `gugu.files` (open / list / create / rename / remove / onChanged), and the verbs main
 * answers for a program. What needs a person's gesture, main refuses.
 *
 * The main thread's alone: a `worker_threads` worker the program starts inherits `--import` and runs this again, with
 * no channel to main (`process.send` is the main thread's) — so there it installs nothing, and the worker runs as plain
 * Node. A worker that needs `gugu` asks its main thread (表格 10-13: the IronCalc thread died on start, every time).
 */
if (isMainThread) {
  Object.defineProperty(globalThis, 'gugu', {
    value: startProgramGugu((globalThis as unknown as { process: ProgramChannel }).process),
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
