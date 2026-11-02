import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confinedEnv, confinedNodeArgs, type ProgramConfinement } from '@shared/extensions/program-confinement';

/**
 * An App's tools program from apiVersion 29 runs within what its manifest declares, not with the person's full rights. The
 * consent sheet says so, so this test is what makes that sentence true. It starts the program the way main starts one
 * (extension-programs.ts): this node, the runtime bundled as the build bundles it (vite.config.mts), the IPC slot, plus
 * the flags and env main derives from the program's confinement (`confinedNodeArgs` / `confinedEnv`, the only place
 * that turns a confinement into a launch). The App code then tries every way out we know of.
 *
 * Each way out is either closed by Node's permission model (`--permission`: fs, child processes, addons, bindings,
 * inspector, WASI) or by the runtime's own gate (`program-confine.ts`: sockets, DNS, eval workers, `node:sqlite`, which
 * Node 24's permission model leaves open). The same corpus run unconfined is the control: if a way out does not work
 * there either, its "denied" here proves nothing, and the test says which one.
 *
 * Network targets are a loopback listener owned by this test, so nothing leaves the machine and CI needs no internet.
 * Alongside each route's error code, the test checks that the listener saw no connection at all.
 */

let dir: string;
let runtime: string;
let bundle: string;
let data: string;
let outside: string;
let listener: Server;
let port: number;
let connections = 0;

function removeFixture(path: string): void {
  if (!dir?.startsWith(join(tmpdir(), 'gugu-program-confine-')) || ![dir, data, outside].includes(path)) throw new Error('Not an owned fixture path');
  process.stderr.write(`Remove own fixture: ${path}\n`);
  rmSync(path, { recursive: true, force: true });
}

/** Every route the corpus tries, in order. The gate's own refusals say `gugu:`; Node's permission model says its own words. */
const FS_ROUTES = ['readOutside', 'listHome', 'writeOutside', 'symlinkOut', 'hardlinkOut'] as const;
const PROCESS_ROUTES = ['spawn', 'execve', 'dlopen', 'binding', 'inspector', 'wasi'] as const;
const GATE_ROUTES = ['sqliteImport', 'sqliteRequire', 'evalWorker', 'workerFromPrototype', 'protoRewrite'] as const;
/** Unconfined there is nothing up the chain to escape to, so it has no control; confined it must stay unreachable. */
const CHAIN_ROUTE = 'workerFromChain';
const NET_ROUTES = ['net', 'getBuiltinNet', 'requireNet', 'subclassSocket', 'tls', 'http', 'http2', 'fetch', 'websocket', 'udp', 'dns', 'unixSocket', 'listen', 'fileWorkerNet', 'fileWorkerNetEmptyEnv', 'fileWorkerNetAfterDeleteEnv'] as const;
const ALLOWED = ['readBundle', 'readData', 'writeData', 'fileWorker'] as const;

const CORPUS = String.raw`
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
const require = createRequire(import.meta.url);
const { PROBE_PORT: port, PROBE_OUTSIDE: outside, PROBE_DATA: data, PROBE_CONTROL: control } = process.env;
const out = {};
// One line per route: 'ok', or the error's code (fetch wraps it in cause). A route that hangs reports 'timeout'.
const t = async (name, fn) => {
  try { await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('timeout'), { code: 'timeout' })), 5000))]); out[name] = 'ok' }
  catch (e) { out[name] = String(e?.cause?.code ?? e?.code ?? e?.message ?? e) }
};
const connect = (make) => new Promise((ok, no) => { const s = make(() => { s.destroy?.(); ok() }); s.on('error', no) });
const net = await import('node:net'); const tls = await import('node:tls'); const http = await import('node:http');
const http2 = await import('node:http2'); const dgram = await import('node:dgram'); const dns = await import('node:dns');

await t('readBundle', () => fs.readFileSync(new URL('./app.mjs', import.meta.url)));
await t('readData', () => fs.readdirSync(data));
await t('writeData', () => fs.writeFileSync(data + '/written', '1'));
await t('readOutside', () => fs.readFileSync(outside + '/secret'));
await t('listHome', () => fs.readdirSync(outside));
await t('writeOutside', () => fs.writeFileSync(outside + '/written', '1'));
await t('symlinkOut', () => fs.symlinkSync(outside + '/secret', data + '/link'));
await t('hardlinkOut', () => fs.linkSync(outside + '/secret', data + '/hard'));

await t('spawn', () => require('node:child_process').execFileSync(process.execPath, ['-e', '0']));
// Unconfined, execve would replace this very process: the control does not run it.
if (!control) await t('execve', () => process.execve(process.execPath, [process.execPath, '-e', '0']));
await t('dlopen', () => process.dlopen({ exports: {} }, outside + '/addon.node'));
await t('binding', () => process.binding('tcp_wrap'));
await t('inspector', async () => (await import('node:inspector')).open(+(process.env.PROBE_INSPECTOR_PORT || 0), '127.0.0.1'));
await t('wasi', async () => new (await import('node:wasi')).WASI({ version: 'preview1' }));

await t('sqliteImport', async () => new (await import('node:sqlite')).DatabaseSync(outside + '/db.sqlite'));
await t('sqliteRequire', () => new (require('node:sqlite').DatabaseSync)(outside + '/db2.sqlite'));
const evalSource = "require('worker_threads').parentPort.postMessage('ran')";
const ranWorker = (w) => new Promise((ok, no) => { w.on('message', () => { w.terminate(); ok() }); w.on('error', no) });
await t('evalWorker', () => ranWorker(new Worker(evalSource, { eval: true })));
// Ways back to an unwrapped Worker: through its prototype's constructor, and up its own prototype chain.
await t('workerFromPrototype', () => ranWorker(new Worker.prototype.constructor(evalSource, { eval: true, execArgv: [] })));
await t('workerFromChain', () => {
  const Up = Object.getPrototypeOf(Worker);
  if (typeof Up !== 'function' || !('terminate' in (Up.prototype ?? {}))) throw Object.assign(new Error('no Worker up the chain'), { code: 'unreachable' });
  return ranWorker(new Up(evalSource, { eval: true, execArgv: [] }));
});

await t('net', () => connect((cb) => net.connect(+port, '127.0.0.1', cb)));
await t('getBuiltinNet', () => connect((cb) => process.getBuiltinModule('node:net').connect(+port, '127.0.0.1', cb)));
await t('requireNet', () => connect((cb) => require('net').connect(+port, '127.0.0.1', cb)));
await t('subclassSocket', () => connect((cb) => { class S extends net.Socket {} return new S().connect(+port, '127.0.0.1', cb) }));
await t('tls', () => connect((cb) => tls.connect({ port: +port, host: '127.0.0.1', rejectUnauthorized: false }, cb)));
await t('http', () => new Promise((ok, no) => http.get('http://127.0.0.1:' + port, ok).on('error', no)));
await t('http2', () => new Promise((ok, no) => { const c = http2.connect('http://127.0.0.1:' + port); c.on('connect', ok); c.on('error', no) }));
await t('fetch', () => fetch('http://127.0.0.1:' + port));
await t('websocket', () => new Promise((ok, no) => { const w = new WebSocket('ws://127.0.0.1:' + port); w.onopen = ok; w.onerror = () => no(Object.assign(new Error('ws'), { code: 'ws-error' })) }));
await t('udp', () => new Promise((ok, no) => dgram.createSocket('udp4').send('x', +port, '127.0.0.1', (e) => (e ? no(e) : ok()))));
await t('dns', () => dns.promises.lookup('localhost'));
await t('unixSocket', () => connect((cb) => net.connect(outside + '/sock', cb)));
await t('listen', () => new Promise((ok, no) => net.createServer().listen(+(process.env.PROBE_LISTEN_PORT || 0), '127.0.0.1', ok).on('error', no)));
await t('fileWorker', () => ranWorker(new Worker(new URL('./worker-ok.mjs', import.meta.url))));
// A worker started with an empty env must not lose the gate (the runtime reads its hosts from env).
await t('fileWorkerNetEmptyEnv', () => new Promise((ok, no) => {
  const w = new Worker(new URL('./worker-net.mjs', import.meta.url), { execArgv: [], env: { PROBE_PORT: port } });
  w.on('message', (m) => { w.terminate(); m === 'ok' ? ok() : no(Object.assign(new Error(m), { code: m })) });
  w.on('error', no);
}));
// …nor when the App deletes the variable from its own env first (a default worker copies process.env).
await t('fileWorkerNetAfterDeleteEnv', () => new Promise((ok, no) => {
  const saved = process.env.GUGU_APP_NETWORK_HOSTS;
  delete process.env.GUGU_APP_NETWORK_HOSTS;
  const w = new Worker(new URL('./worker-net.mjs', import.meta.url), { execArgv: [] });
  if (saved !== undefined) process.env.GUGU_APP_NETWORK_HOSTS = saved;
  w.on('message', (m) => { w.terminate(); m === 'ok' ? ok() : no(Object.assign(new Error(m), { code: m })) });
  w.on('error', no);
}));
await t('fileWorkerNet', () => new Promise((ok, no) => {
  const w = new Worker(new URL('./worker-net.mjs', import.meta.url), { execArgv: [] });
  w.on('message', (m) => { w.terminate(); m === 'ok' ? ok() : no(Object.assign(new Error(m), { code: m })) });
  w.on('error', no);
}));
// Last: unconfined it succeeds and breaks every socket after it.
await t('protoRewrite', () => { net.Socket.prototype.connect = function () {}; });
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
`;

const WORKER_OK = "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ran');";
const WORKER_NET = String.raw`
import net from 'node:net'; import { parentPort } from 'node:worker_threads';
try { const s = net.connect(+process.env.PROBE_PORT, '127.0.0.1', () => { s.destroy(); parentPort.postMessage('ok') }); s.on('error', (e) => parentPort.postMessage(String(e.code))) }
catch (e) { parentPort.postMessage(String(e.code)) }
`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gugu-program-confine-'));
  const runtimeDir = join(dir, 'runtime');
  bundle = join(dir, 'bundle');
  data = join(dir, 'data');
  outside = join(dir, 'outside');
  for (const d of [runtimeDir, bundle, data, outside]) mkdirSync(d);
  runtime = join(runtimeDir, 'gugu-program.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./program-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: runtime,
    logLevel: 'silent',
  });
  writeFileSync(join(bundle, 'app.mjs'), CORPUS);
  writeFileSync(join(bundle, 'worker-ok.mjs'), WORKER_OK);
  writeFileSync(join(bundle, 'worker-net.mjs'), WORKER_NET);
  writeFileSync(join(outside, 'secret'), 'not yours');
  // Answers anything with a minimal HTTP response, so the control's http / fetch complete rather than hang.
  listener = createServer((socket) => { connections += 1; socket.on('error', () => {}); socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n') });
  await new Promise<void>((ok) => listener.listen(Number(process.env.A5_PROBE_PORT || 0), '127.0.0.1', ok));
  port = (listener.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  if (listener) await new Promise((ok) => listener.close(ok));
  if (dir) removeFixture(dir);
});

function confinement(hosts: string[] = []): ProgramConfinement {
  return { fsRead: [bundle, join(dir, 'runtime'), data], fsWrite: [data], hosts };
}

/** The corpus's verdicts, started as main starts a program; `confine` null = today's unconfined launch (the control). */
async function runCorpus(confine: ProgramConfinement | null): Promise<Record<string, string>> {
  // Each run starts from the same files: what the last one wrote (the control writes everywhere) is gone.
  for (const d of [data, outside]) { removeFixture(d); mkdirSync(d) }
  writeFileSync(join(outside, 'secret'), 'not yours');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.NODE_OPTIONS;
  Object.assign(env, { PROBE_PORT: String(port), PROBE_OUTSIDE: outside, PROBE_DATA: data,
    ...(process.env.A5_PROBE_PORT ? { PROBE_LISTEN_PORT: String(port + 1), PROBE_INSPECTOR_PORT: String(port + 2) } : {}) },
  confine ? confinedEnv(confine) : { PROBE_CONTROL: '1' });
  const args = [...(confine ? confinedNodeArgs(confine, join(dir, 'runtime')) : []), '--import', pathToFileURL(runtime).href, join(bundle, 'app.mjs')];
  const said = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: bundle, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
  });
  const line = said.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as Record<string, string>;
  } catch {
    throw new Error(`the corpus did not finish: stdout ${JSON.stringify(said.stdout)} stderr ${JSON.stringify(said.stderr)}`);
  }
}

describe('an App tools program runs within what it declared (apiVersion 29)', () => {
  it('control: unconfined, every way out works — so each denial below is the gate, not the test', async () => {
    connections = 0;
    const out = await runCorpus(null);
    // execve is not run unconfined (it would replace the process); dlopen/inspector/wasi/unixSocket/tls fail
    // unconfined for reasons of their own (no addon file, no socket file, a TLS handshake against a plain listener),
    // so they get no control here: their confined assertions rest on the exact code instead.
    const controlled = [...FS_ROUTES, 'spawn', 'binding', ...GATE_ROUTES, 'net', 'getBuiltinNet', 'requireNet', 'subclassSocket', 'http', 'fetch', 'udp', 'listen', 'fileWorker', 'fileWorkerNet', 'fileWorkerNetEmptyEnv', 'fileWorkerNetAfterDeleteEnv', ...ALLOWED];
    for (const route of controlled) expect.soft(out[route], route).toBe('ok');
    expect(connections).toBeGreaterThan(0);
  }, 60_000);

  it('undeclared network, files only through gugu: every way out is refused with ERR_ACCESS_DENIED, nothing reaches the network', async () => {
    connections = 0;
    const out = await runCorpus(confinement());
    for (const route of ALLOWED) expect.soft(out[route], route).toBe('ok');
    for (const route of [...FS_ROUTES, ...PROCESS_ROUTES, ...GATE_ROUTES, ...NET_ROUTES]) {
      // fetch / WebSocket surface their own wrapper; everything else must be the one code an agent can read.
      if (route === 'websocket') expect.soft(out[route], route).toBe('ERR_ACCESS_DENIED');
      else if (route === 'dlopen') expect.soft(out[route], route).toBe('ERR_DLOPEN_DISABLED');
      else if (route === 'protoRewrite') expect.soft(out[route], route).toMatch(/read.only|Cannot assign/);
      else expect.soft(out[route], route).toBe('ERR_ACCESS_DENIED');
    }
    expect.soft(out[CHAIN_ROUTE], CHAIN_ROUTE).toBe('unreachable');
    // The only proof that matters for the consent sheet's sentence: the listener never saw this program.
    expect(connections).toBe(0);
    // Nothing was written outside the data folder.
    expect(readdirSync(outside).sort()).toEqual(['secret']);
  }, 60_000);

  it('declared hosts: a declared name passes the gate; any other name and every IP literal stays refused', async () => {
    connections = 0;
    const src = String.raw`
      import net from 'node:net';
      const out = {};
      const t = (name, host) => new Promise((done) => {
        try { const s = net.connect({ port: +process.env.PROBE_PORT, host, lookup: (_host, options, cb) => cb(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) }, () => { s.destroy(); out[name] = 'ok'; done() }); s.on('error', (e) => { out[name] = String(e.code); done() }); setTimeout(() => { s.destroy(); out[name] ??= 'timeout'; done() }, 5000) }
        catch (e) { out[name] = String(e.code); done() }
      });
      await t('declared', 'allowed.invalid');
      await t('wildcard', 'deep.wild.invalid');
      await t('other', 'denied.invalid');
      await t('ip', '127.0.0.1');
      process.stdout.write(JSON.stringify(out) + '\n'); process.exit(0);
    `;
    writeFileSync(join(bundle, 'app.mjs'), src);
    try {
      const out = await runCorpus(confinement(['allowed.invalid', '*.wild.invalid']));
      // A fixture-only resolver maps both allowed names to our listener; no external DNS or sockets.
      expect(out.declared).toBe('ok');
      expect(out.wildcard).toBe('ok');
      expect(out.other).toBe('ERR_ACCESS_DENIED');
      expect(out.ip).toBe('ERR_ACCESS_DENIED');
      expect(connections).toBe(2);
    } finally {
      writeFileSync(join(bundle, 'app.mjs'), CORPUS);
    }
  }, 60_000);

  it('a refusal says what the App did not declare, on the line an agent reads back', async () => {
    writeFileSync(join(bundle, 'app.mjs'), "await fetch('http://127.0.0.1:65000').catch((e) => { process.stderr.write(String(e.cause?.message ?? e.message ?? e) + '\\n'); process.exit(1) });");
    try {
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...confinedEnv(confinement()) };
      delete env.NODE_OPTIONS;
      const stderr = await new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [...confinedNodeArgs(confinement(), join(dir, 'runtime')), '--import', pathToFileURL(runtime).href, join(bundle, 'app.mjs')], { cwd: bundle, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
        let err = '';
        child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('close', () => resolve(err));
      });
      const last = stderr.trim().split('\n').pop() ?? '';
      expect(last).toMatch(/^gugu: .*did not declare network/);
      // The permission model's own SecurityWarning must not be the last line people see.
      expect(stderr).not.toMatch(/SecurityWarning/);
    } finally {
      writeFileSync(join(bundle, 'app.mjs'), CORPUS);
    }
  }, 60_000);
});
