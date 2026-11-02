import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import threads, { type WorkerOptions } from 'node:worker_threads';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { networkHostAllowed } from '@shared/extensions/network-host';
import { resolvesInside } from '@shared/extensions/path-containment';

// A seat belt for declared tools, not an OS sandbox for malicious code. Runs in every thread before App code.
const hosts: string[] = JSON.parse(process.env.GUGU_APP_NETWORK_HOSTS!);
const hostEnv = JSON.stringify(hosts);
const root = process.cwd();
const execArgv = [...process.execArgv];
const deny = (what: string): never => { throw Object.assign(new Error(`gugu: this App ${what}`), { code: 'ERR_ACCESS_DENIED' }); };
const lock = (object: object, key: PropertyKey, value: unknown) => Object.defineProperty(object, key, { value, writable: false, configurable: false });
const allow = (host: unknown) => {
  if (typeof host !== 'string' || net.isIP(host.replace(/^\[|\]$/g, '')) || !networkHostAllowed(hosts, host)) {
    deny(`did not declare network access to ${typeof host === 'string' ? host : 'this socket'}`);
  }
};

const connect = net.Socket.prototype.connect;
lock(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    const options = first as { host?: unknown; path?: unknown };
    if (options.path !== undefined) deny('cannot use Unix sockets');
    allow(options.host);
  } else allow(typeof first === 'number' ? args[1] : undefined);
  return Reflect.apply(connect, this, args);
});
lock(net.Server.prototype, 'listen', () => deny('cannot listen for network connections'));
lock(dgram.Socket.prototype, 'bind', () => deny('cannot bind UDP sockets'));
for (const key of ['send', 'connect'] as const) {
  const original = dgram.Socket.prototype[key];
  lock(dgram.Socket.prototype, key, function (this: dgram.Socket, ...args: unknown[]) {
    const address = key === 'connect' ? 1 : typeof args[2] === 'number' ? 4 : 2;
    allow(args[address]);
    return Reflect.apply(original, this, args);
  });
}
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveMx',
    'resolveNs', 'resolveSrv', 'resolveCname', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'resolveCaa', 'reverse', 'setServers']) {
    const original = Reflect.get(target, key);
    if (typeof original !== 'function') continue;
    lock(target, key, function (this: unknown, ...args: unknown[]) {
      if (key === 'setServers') deny('cannot replace the DNS servers');
      allow(args[0]);
      return Reflect.apply(original, this, args);
    });
  }
}

// Fetch otherwise wraps a socket refusal as a generic TypeError; keep the declared-host error visible to tools.
const fetch = globalThis.fetch;
lock(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  allow(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname);
  try { return await fetch(input, init); }
  catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ERR_ACCESS_DENIED') throw cause;
    throw error;
  }
});
const WebSocket = globalThis.WebSocket;
function ConfinedWebSocket(url: string | URL, protocols?: string | string[]) {
  allow(new URL(url).hostname);
  return Reflect.construct(WebSocket, [url, protocols], new.target);
}
Object.defineProperty(ConfinedWebSocket, 'prototype', { value: WebSocket.prototype });
for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) lock(ConfinedWebSocket, key, WebSocket[key]);
lock(WebSocket.prototype, 'constructor', ConfinedWebSocket);
lock(globalThis, 'WebSocket', ConfinedWebSocket);

const Worker = threads.Worker;
function ConfinedWorker(source: string | URL, options: WorkerOptions = {}) {
  if (options.eval) deny('cannot run eval workers');
  const file = source instanceof URL && source.protocol === 'file:' ? fileURLToPath(source) : source;
  if (typeof file !== 'string' || !resolvesInside(root, relative(root, file))) deny('can run only bundle file workers');
  return Reflect.construct(Worker, [source, { ...options, execArgv,
    env: { ...process.env, ...(typeof options.env === 'object' ? options.env : {}), NODE_OPTIONS: '', GUGU_APP_NETWORK_HOSTS: hostEnv } }], new.target);
}
Object.defineProperty(ConfinedWorker, 'prototype', { value: Worker.prototype });
lock(Worker.prototype, 'constructor', ConfinedWorker);
lock(threads, 'Worker', ConfinedWorker);
// getBuiltinModule bypasses module hooks; lock both that entrance and the underlying CJS constructor.
const getBuiltinModule = process.getBuiltinModule;
function denySqlite(): never { return deny('cannot use node:sqlite; use its data folder or Gugu files'); }
const sqlite = getBuiltinModule('node:sqlite');
if (sqlite) lock(sqlite, 'DatabaseSync', denySqlite);
lock(process, 'getBuiltinModule', (id: string) => {
  if (id === 'node:sqlite' || id === 'sqlite') return denySqlite();
  return getBuiltinModule(id);
});
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:sqlite' || specifier === 'sqlite') {
    return { url: 'gugu-denied:sqlite', shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  return url === 'gugu-denied:sqlite'
    ? { format: 'commonjs', shortCircuit: true, source: "throw Object.assign(new Error('gugu: this App cannot use node:sqlite; use its data folder or Gugu files'), { code: 'ERR_ACCESS_DENIED' })" }
    : next(url, context);
} });
syncBuiltinESMExports();
