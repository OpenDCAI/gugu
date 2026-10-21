import crypto from 'node:crypto';
import http from 'node:http';
import { log } from '@main/lib/logger';
import { listenStable, type EndpointLog, type EndpointPorts, type PersistedRecords } from '@main/lib/stable-endpoint';

export interface RawHookRequest {
  ptyId: string;
  type: string;
  body: string;
  /** Which spawn posted this. It is the only thing that tells two generations of one ptyId apart. */
  sourceId: string;
  /** The harness version that spawn was probed at (runtime-compatible probe); null when not probed. */
  harnessVersion: string | null;
  /**
   * When the request reached this server (`Date.now()`): the event's time from here on. The harness waits for each hook's
   * answer before it goes on, so this order is the order the agent did things in — what main does with each event after
   * (async, one by one) is not (#7141 review 9a096d48bd: a late Stop stamped after enrichment read as the next round's).
   */
  receivedAt: number;
}

/**
 * The hook credentials handed to exactly one agent process.
 * `keepAcrossRestart(sessionId)`: the agent runs in tmux and outlives this host process — persist the
 * credentials so the next host process accepts its hooks and hands the same source back on re-attach (#6264).
 */
export type HookSource = { id: string; token: string; dispose(): void; keepAcrossRestart(ptySessionId: string): void };

/** A persisted source (`key` = its token). */
export type PersistedHookSource = { key: string; id: string; ptyId: string; harnessVersion: string | null; ptySessionId: string };

export type HookServerPersistence = {
  ports: EndpointPorts;
  sources: PersistedRecords<PersistedHookSource>;
  log: EndpointLog;
};

export type HookHandler = (raw: RawHookRequest) => Promise<void>;

export class HookServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly sources = new Map<string, { id: string; ptyId: string; harnessVersion: string | null }>();
  private persistence: HookServerPersistence | null = null;
  /** Sources persisted by the previous host process, by PTY session id, waiting for their session to re-attach. */
  private readonly restoredByPtySession = new Map<string, HookSource>();

  /**
   * #6264 Keep this server's port and every tmux-held source across host-process restarts (see stable-endpoint.ts).
   * Must be called before start(); the persisted sources are accepted from the moment the port is re-bound.
   */
  usePersistence(persistence: HookServerPersistence): void {
    this.persistence = persistence;
    for (const record of persistence.sources.list()) {
      if (typeof record.id !== 'string' || typeof record.ptyId !== 'string' || typeof record.ptySessionId !== 'string') continue;
      this.sources.set(record.key, { id: record.id, ptyId: record.ptyId, harnessVersion: record.harnessVersion ?? null });
      this.restoredByPtySession.set(record.ptySessionId, this.sourceHandle(record.key, record.id, record.ptyId, record.harnessVersion ?? null));
    }
  }

  /**
   * The source a previous host process handed to the agent still running in this session's tmux, if any.
   * Taken once: the caller registers it as the live generation's credentials.
   */
  takeRestoredSource(ptySessionId: string): HookSource | undefined {
    const source = this.restoredByPtySession.get(ptySessionId);
    this.restoredByPtySession.delete(ptySessionId);
    return source;
  }

  private sourceHandle(token: string, id: string, ptyId: string, harnessVersion: string | null): HookSource {
    return {
      id,
      token,
      dispose: () => {
        this.sources.delete(token);
        this.persistence?.sources.remove(token);
      },
      keepAcrossRestart: (ptySessionId) => {
        if (!this.sources.has(token)) return;
        this.persistence?.sources.put({ key: token, id, ptyId, harnessVersion, ptySessionId });
      },
    };
  }

  /**
   * Mint one spawn's credentials. A ptyId is stable across respawns, so the token is what makes an
   * arriving event attributable: a retired spawn's hooks keep their own id and can never be read as
   * the current one's.
   */
  createSource(ptyId: string, harnessVersion: string | null): HookSource {
    const token = crypto.randomUUID();
    const id = crypto.randomUUID();
    this.sources.set(token, { id, ptyId, harnessVersion });
    return this.sourceHandle(token, id, ptyId, harnessVersion);
  }

  async start(handler: HookHandler): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      const receivedAt = Date.now();
      if (req.method !== 'POST' || req.url !== '/hook') {
        res.writeHead(404);
        res.end();
        return;
      }
      // Resolved before the body so that revoking a source mid-request cannot re-attribute a
      // request that was already admitted as the old spawn's.
      const token = req.headers['x-gugu-token'];
      const source = typeof token === 'string' ? this.sources.get(token) : undefined;
      if (!source) {
        log.warn('HookServer: rejected request with invalid token');
        res.writeHead(403);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 1_000_000) {
          req.destroy();
        }
      });

      req.on('end', () => {
        const ptyId = String(req.headers['x-gugu-pty-id'] || '');
        const type = String(req.headers['x-gugu-event-type'] || '');
        if (!ptyId || !type) {
          log.warn('HookServer: malformed request — missing ptyId or type headers');
          res.writeHead(400);
          res.end();
          return;
        }
        if (source.ptyId !== ptyId) {
          log.warn('HookServer: rejected request posting for another ptyId', { ptyId });
          res.writeHead(403);
          res.end();
          return;
        }
        // 收到即记(只记类型与会话,❌ 不记 payload):再遇到「回合起点晚到 / 没到」时,这一行分得清
        // 是 harness 发晚了还是宿主收晚了(#5922 实测时这一段没有任何记录)。时间戳由 logger 给。
        log.debug('HookServer: received', { ptyId, type });
        handler({ ptyId, type, body, sourceId: source.id, harnessVersion: source.harnessVersion, receivedAt })
          .then(() => {
            res.writeHead(200);
            res.end();
          })
          .catch((err) => {
            log.warn('HookServer: handler error', { error: String(err) });
            res.writeHead(500);
            res.end();
          });
      });
    });

    if (this.persistence) {
      const server = this.server;
      const { port, reused } = await listenStable(server, { name: 'hook-server', ports: this.persistence.ports, log: this.persistence.log });
      this.port = port;
      server.on('error', (err) => log.error('HookServer: server error', { error: String(err) }));
      log.info('HookServer: started', { port, reusedPort: reused, restoredSources: this.restoredByPtySession.size });
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        log.info('HookServer: started', { port: this.port });
        resolve();
      });
      this.server!.on('error', (err) => {
        log.error('HookServer: failed to start', { error: String(err) });
        reject(err);
      });
    });
  }

  stop(): void {
    // Only the in-memory table: persisted tmux-held sources outlive this process on purpose.
    this.sources.clear();
    this.restoredByPtySession.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
  }
  getPort(): number {
    return this.port;
  }
}
