import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// behavior tab-extensions (#2374) —— 网络白名单**接线**的判据。
//
// 为什么单独写这一份:纯决策函数 `decideExtensionRequest` 早有测试,但「它有没有被
// 挂到这个扩展的 session 上」此前没有任何判据。e2e 里那几条网络结论用的是 `.test`
// 域名(RFC 2606,永不解析),所以把整个 `onBeforeRequest` 删掉,它们**照样报 blocked**
// —— DNS 失败和白名单拦截在探针那头长得一模一样。这份测试就是那条对照:
// 拆掉注册即红,且正反两面都判(声明过的必须放行,没声明的必须拦)。

const sessions = new Map<string, FakeSession>();

type RequestFilter = (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void
) => void;

class FakeSession {
  beforeRequest: RequestFilter | null = null;
  permissionRequestHandler:
    | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | null = null;
  permissionCheckHandler: ((webContents: unknown, permission: string) => boolean) | null = null;
  handledSchemes = new Set<string>();
  protocolHandlers = new Map<string, (request: { url: string }) => Promise<Response>>();

  beforeSendHeaders:
    | ((
        details: { id: number; requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders: Record<string, string> }) => void
      ) => void)
    | null = null;
  headersReceived:
    | ((
        details: { id: number; responseHeaders: Record<string, string[]> | null },
        callback: (response: { responseHeaders: Record<string, string[]> | null }) => void
      ) => void)
    | null = null;

  webRequest = {
    onBeforeRequest: (filter: RequestFilter) => {
      this.beforeRequest = filter;
    },
    onBeforeSendHeaders: (handler: FakeSession['beforeSendHeaders']) => {
      this.beforeSendHeaders = handler;
    },
    onHeadersReceived: (handler: FakeSession['headersReceived']) => {
      this.headersReceived = handler;
    },
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn(),
  };

  protocol = {
    isProtocolHandled: (scheme: string) => this.handledSchemes.has(scheme),
    handle: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => {
      this.handledSchemes.add(scheme);
      this.protocolHandlers.set(scheme, handler);
    },
    unhandle: (scheme: string) => {
      this.handledSchemes.delete(scheme);
      this.protocolHandlers.delete(scheme);
    },
  };

  setPermissionRequestHandler(handler: FakeSession['permissionRequestHandler']) {
    this.permissionRequestHandler = handler;
  }
  setPermissionCheckHandler(handler: FakeSession['permissionCheckHandler']) {
    this.permissionCheckHandler = handler;
  }
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
}

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created = new FakeSession();
      sessions.set(partition, created);
      return created;
    },
  },
  // Echoes the file URL it was asked for, so a response body says which
  // directory on disk actually got served.
  net: { fetch: vi.fn(async (url: string) => new Response(url, { status: 200 })) },
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { extensionPartition } from '@shared/extensions/partition';
import {
  clearExtensionSessionData,
  configureExtensionSession,
  configuredExtensionIds,
  extensionIdForSession,
} from './extension-session';

const EXTENSION_ID = 'arxiv-search';

function bundle(networkHosts: readonly string[], rootDir = '/bundles/v1') {
  return { extensionId: EXTENSION_ID, rootDir, networkHosts };
}

function fakeSessionFor(extensionId: string): FakeSession {
  const found = sessions.get(extensionPartition(extensionId));
  if (!found) throw new Error('the extension was never configured');
  return found;
}

/** What the session filter decides for one URL, through the registered callback. */
function verdictFor(target: FakeSession, url: string): 'allowed' | 'cancelled' {
  const filter = target.beforeRequest;
  // A missing filter is the mutation this file exists to catch — it must not
  // read as a pass, so it fails here rather than defaulting either way.
  expect(filter, 'no request filter was installed on the extension session').not.toBeNull();
  let decision: 'allowed' | 'cancelled' | null = null;
  filter?.({ url }, ({ cancel }) => {
    decision = cancel ? 'cancelled' : 'allowed';
  });
  expect(decision, 'the request filter answered nothing').not.toBeNull();
  return decision as unknown as 'allowed' | 'cancelled';
}

beforeEach(async () => {
  for (const extensionId of configuredExtensionIds()) await clearExtensionSessionData(extensionId);
  sessions.clear();
});

describe('configureExtensionSession', () => {
  it('lets a declared host through and cancels one that was never declared', () => {
    configureExtensionSession(bundle(['export.arxiv.org']));
    const ses = fakeSessionFor(EXTENSION_ID);

    // Both directions, because "everything is blocked" would satisfy the
    // negative one on its own — including when nothing is enforcing at all.
    expect(verdictFor(ses, 'https://export.arxiv.org/api/query')).toBe('allowed');
    expect(verdictFor(ses, 'https://evil.example.com/steal')).toBe('cancelled');
  });

  it('cancels plaintext and loopback even for a host that was declared', () => {
    configureExtensionSession(bundle(['export.arxiv.org', '127.0.0.1']));
    const ses = fakeSessionFor(EXTENSION_ID);

    expect(verdictFor(ses, 'http://export.arxiv.org/api/query')).toBe('cancelled');
    expect(verdictFor(ses, 'https://127.0.0.1/admin')).toBe('cancelled');
  });

  it('serves the extension its own bundle over its own scheme', () => {
    configureExtensionSession(bundle(['export.arxiv.org']));
    expect(fakeSessionFor(EXTENSION_ID).handledSchemes.has('gugu-ext')).toBe(true);
  });

  it('follows a shortened grant list on the session it already installed', () => {
    configureExtensionSession(bundle(['export.arxiv.org']));
    const ses = fakeSessionFor(EXTENSION_ID);
    expect(verdictFor(ses, 'https://export.arxiv.org/api/query')).toBe('allowed');

    // Revoking is a new grant list on the live session, not a new session —
    // the surface stays up, it just stops being able to reach that host.
    configureExtensionSession(bundle([]));
    expect(fakeSessionFor(EXTENSION_ID)).toBe(ses);
    expect(verdictFor(ses, 'https://export.arxiv.org/api/query')).toBe('cancelled');
  });

  it('follows a widened grant list too, so a re-consent takes effect at once', () => {
    configureExtensionSession(bundle([]));
    const ses = fakeSessionFor(EXTENSION_ID);
    expect(verdictFor(ses, 'https://api.example.com/v1')).toBe('cancelled');

    configureExtensionSession(bundle(['api.example.com']));
    expect(verdictFor(ses, 'https://api.example.com/v1')).toBe('allowed');
  });

  it('refuses every web permission but the one that carries no capability', () => {
    configureExtensionSession(bundle([]));
    const ses = fakeSessionFor(EXTENSION_ID);

    const decide = (permission: string) => {
      let granted: boolean | null = null;
      ses.permissionRequestHandler?.(null, permission, (value) => {
        granted = value;
      });
      return granted;
    };

    expect(decide('clipboard-sanitized-write')).toBe(true);
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'display-capture']) {
      expect(decide(permission), `${permission} must not be granted`).toBe(false);
      expect(ses.permissionCheckHandler?.(null, permission)).toBe(false);
    }
  });

  // 升版与撤销都发生在同一个 session 上(session 比它第一次配置时的那份 bundle 活得久)。
  // 供给端若把 bundle 闭包捕获,就会出现两种谁都不会当场发现的坏法:
  //   服的 CSP 还是旧版的 → 刚点头的域名被 session 放行、被头部拒掉,两层互相打架;
  //   服的目录还是旧版的 → 升了版,跑的还是上一版的代码。
  describe('a session that outlives the bundle it started with', () => {
    async function serve(url: string): Promise<Response> {
      const handler = fakeSessionFor(EXTENSION_ID).protocolHandlers.get('gugu-ext');
      expect(handler, 'the extension scheme was never handled').toBeDefined();
      return handler!({ url });
    }

    it('stamps the current grant list into the served CSP', async () => {
      configureExtensionSession(bundle([]));
      const before = await serve(`gugu-ext://${EXTENSION_ID}/index.html`);
      expect(before.headers.get('Content-Security-Policy')).not.toContain('api.example.com');

      // What a re-consent on upgrade produces: one more host, same session.
      configureExtensionSession(bundle(['api.example.com']));
      const after = await serve(`gugu-ext://${EXTENSION_ID}/index.html`);
      expect(after.headers.get('Content-Security-Policy')).toContain(
        'connect-src \'self\' https://api.example.com wss://api.example.com'
      );
    });

    it('serves the upgraded bundle rather than the directory it was installed from', async () => {
      const root = mkdtempSync(join(tmpdir(), 'gugu-ext-session-'));
      const v1 = join(root, 'v1');
      const v2 = join(root, 'v2');
      for (const dir of [v1, v2]) {
        mkdirSync(dir);
        writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      }

      configureExtensionSession(bundle([], v1));
      expect(await (await serve(`gugu-ext://${EXTENSION_ID}/index.html`)).text()).toContain(v1);

      configureExtensionSession(bundle([], v2));
      const served = await (await serve(`gugu-ext://${EXTENSION_ID}/index.html`)).text();
      expect(served).toContain(v2);
      expect(served, 'the previous version must stop being reachable').not.toContain(`${v1}/`);
    });
  });

  // 这一段补的是审计点名的空白:把 CORS 那三个 handler 整段删掉,此前**没有任何测试会红**
  // —— 假 session 把它们都桩成了 vi.fn(),纯函数那份测试照旧绿,而 e2e 的每一条网络结论
  // 都只判「被拦」。后果是扩展的每一次跨域 fetch 静默死在 CORS 上:那正是仓库里那个样张
  // 扩展(arxiv-search)唯一依赖的能力,也是文档许诺的「不需要对方站点配合」。
  describe('the grant that makes a declared host actually usable', () => {
    function corsRoundTrip(target: FakeSession, origin: string) {
      const request = { id: 7, requestHeaders: { Origin: origin } };
      expect(target.beforeSendHeaders, 'no request-header hook was installed').not.toBeNull();
      target.beforeSendHeaders?.(request, () => undefined);

      let granted: Record<string, string[]> | null = null;
      expect(target.headersReceived, 'no response-header hook was installed').not.toBeNull();
      target.headersReceived?.({ id: 7, responseHeaders: { 'content-type': ['application/json'] } }, ({ responseHeaders }) => {
        granted = responseHeaders;
      });
      return granted as Record<string, string[]> | null;
    }

    it('answers the CORS question itself for the extension’s own origin', () => {
      configureExtensionSession(bundle(['export.arxiv.org']));
      const ses = fakeSessionFor(EXTENSION_ID);

      const headers = corsRoundTrip(ses, `gugu-ext://${EXTENSION_ID}`);

      // No public API returns Access-Control-Allow-Origin for a custom scheme, so
      // without this the allowlist would permit a request whose response the
      // renderer then throws away — "declared" would not mean "usable".
      expect(headers?.['Access-Control-Allow-Origin']).toEqual([`gugu-ext://${EXTENSION_ID}`]);
    });

    it('grants nothing to an origin that is not this extension', () => {
      configureExtensionSession(bundle(['export.arxiv.org']));
      const ses = fakeSessionFor(EXTENSION_ID);

      const headers = corsRoundTrip(ses, 'https://evil.example.com');

      expect(headers?.['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  it('stops serving the old bundle after an uninstall and reinstall', async () => {
    // `session.fromPartition` hands back the *same* Session on reinstall, so a
    // handler left registered would still be the one closing over the removed
    // extension's entry: the new version's files served with the old version's
    // CSP, while the request filter enforces the new host list. That is the
    // header/enforcement contradiction the live-bundle refactor exists to stop.
    configureExtensionSession(bundle(['old.example.com'], '/bundles/v1'));
    const ses = fakeSessionFor(EXTENSION_ID);

    await clearExtensionSessionData(EXTENSION_ID);
    expect(ses.handledSchemes.has('gugu-ext'), 'the handler must come off with the entry').toBe(
      false
    );

    configureExtensionSession(bundle(['new.example.com'], '/bundles/v2'));
    const handler = fakeSessionFor(EXTENSION_ID).protocolHandlers.get('gugu-ext');
    const response = await handler!({ url: `gugu-ext://${EXTENSION_ID}/index.html` });
    const csp = response.headers.get('Content-Security-Policy') ?? '';

    expect(csp).toContain('https://new.example.com');
    expect(csp, 'the removed version must stop being described').not.toContain('old.example.com');
  });

  it('knows which extension a session belongs to, and forgets it on uninstall', async () => {
    const ses = configureExtensionSession(bundle([]));
    expect(extensionIdForSession(ses)).toBe(EXTENSION_ID);
    expect(configuredExtensionIds().has(EXTENSION_ID)).toBe(true);

    await clearExtensionSessionData(EXTENSION_ID);

    // The attach gate admits only configured partitions, so forgetting is what
    // stops an uninstalled extension's surface from being re-attachable.
    expect(configuredExtensionIds().has(EXTENSION_ID)).toBe(false);
    expect(extensionIdForSession(ses)).toBeNull();
    expect(ses.clearStorageData).toHaveBeenCalled();
    expect(ses.clearCache).toHaveBeenCalled();
  });
});
