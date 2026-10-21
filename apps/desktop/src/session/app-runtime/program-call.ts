import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tool call an App's program is running code for right now: its id, minted by main for that one call
 * (`_meta['gugu/call']`). Every `gugu.*` verb the program sends while it runs carries it, so main answers the verb as
 * that call's agent — never by guessing from which calls happen to hold the same file or chat. Outside every call (a
 * timer, a file's change) there is none, and the verb is the App's own, as a page's.
 *
 * One instance per process: the two bundles a program runs in (`gugu-program.mjs` puts `gugu` on it, `gugu-tools.mjs`
 * runs the tools) share it through a well-known symbol.
 */
const KEY = Symbol.for('gugu.program.call');
const shared = globalThis as unknown as Record<symbol, AsyncLocalStorage<string> | undefined>;

export const programCall: AsyncLocalStorage<string> = (shared[KEY] ??= new AsyncLocalStorage<string>());
