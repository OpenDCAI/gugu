import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { WebContents } from 'electron';
import type { PageProtocol } from '../page-protocol';
import { withinDeadline } from './page-protocol-deadline';

/** A navigation can invalidate its own Runtime.evaluate response. Acknowledge script
 * installation first, then release its source and observe the actual navigation. */
export async function navigateHistoryFromScript(contents: WebContents, lease: PageProtocol, delta: -1 | 1): Promise<void> {
  let requested!: (response: ServerResponse) => void;
  const request = new Promise<ServerResponse>(resolve => { requested = resolve; });
  const server = createServer((_request, response) => { requested(response); });
  let loaded!: () => void;
  const navigation = new Promise<void>(resolve => { loaded = resolve; });
  contents.once('did-finish-load', loaded);
  try {
    await withinDeadline((async () => {
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      const port = (server.address() as { port: number }).port;
      await lease.send('Runtime.evaluate', {
        expression: `void document.head.appendChild(Object.assign(document.createElement('script'), { src: 'http://127.0.0.1:${port}/' }))`,
      });
      const response = await request;
      response.setHeader('Content-Type', 'application/javascript');
      response.end(`history.go(${delta})`);
      await navigation;
    })(), 'history script');
  } finally {
    contents.removeListener('did-finish-load', loaded);
    server.closeAllConnections();
    if (server.listening) server.close();
  }
}
