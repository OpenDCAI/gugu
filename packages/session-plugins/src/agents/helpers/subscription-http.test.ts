import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { requestSubscriptionJson } from './subscription-http';

let server: Server;
afterEach(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it('reads actual JSON with the supplied authentication on the selected network', async () => {
  let auth: string | undefined;
  const url = await listen((request, response) => {
    auth = request.headers.authorization;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ five_hour: { utilization: 12 } }));
  });
  await expect(requestSubscriptionJson({ env: {} }, url, { authorization: 'Bearer test-only' })).resolves.toEqual({ five_hour: { utilization: 12 } });
  expect(auth).toBe('Bearer test-only');
});

it('does not expose response bodies in quota errors', async () => {
  const url = await listen((_request, response) => { response.statusCode = 429; response.end('secret-in-vendor-body'); });
  await expect(requestSubscriptionJson({ env: {} }, url, {})).rejects.toThrow('厂商暂时限制额度查询');
});

it('rejects redirects instead of sending account credentials to another destination', async () => {
  let requests = 0;
  const url = await listen((_request, response) => { requests++; response.statusCode = 302; response.setHeader('location', '/elsewhere'); response.end(); });
  await expect(requestSubscriptionJson({ env: {} }, url, { authorization: 'Bearer test-only' })).rejects.toThrow();
  expect(requests).toBe(1);
});
