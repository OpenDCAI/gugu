import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serveTools, toolsOf } from './tools-host';

/**
 * `<runtime>/gugu-tools.mjs <bundle>/tools.js` — 摩擦单 F77: an App's `mcpServers: [{ name, tools }]` program. Main
 * starts it on gugu's own node after `--import gugu-program.mjs`, so the tools module has the global `gugu` its pages
 * have; it may import files of its bundle and Node's built-in modules (there is no node_modules in a bundle).
 * What stops it is said on one line of stderr — the line an agent reads back from app_check and the catalog.
 */
const file = process.argv[2] ?? '';
try {
  const tools = toolsOf(await import(pathToFileURL(file).href), basename(file));
  await serveTools(tools, new StdioServerTransport(), { name: process.env.GUGU_EXTENSION_ID ?? 'app', version: '1' });
} catch (error) {
  // Where in the App it threw (a throw at the top of a module), as `tools.js:12`: the first frame that is not this
  // runtime's own. A syntax error has no frame; its kind says what it is.
  const frame = String((error as Error | undefined)?.stack ?? '')
    .split('\n')
    .find((line) => line.includes('file://') && !line.includes(import.meta.url));
  const where = frame && /([^/\\\s)]+\.m?js:\d+)/.exec(frame)?.[1];
  process.stderr.write(`${where ? `${where}: ` : ''}${String(error)}\n`);
  process.exit(1);
}
