import { describe, expect, it, vi } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { page } from './test-support/page-protocol-fixture';

describe('host-selected page protocol lease', () => {
  it('removes forbidden back and forward history before attaching, preserving current and ordinary entries', async () => {
    const current = page(['file:///private/secret', 'http://example.test/before', 'https://example.test/current', 'chrome://gpu', 'about:blank'], 2);
    const lease = createPageProtocol(current.contents);
    const attach = current.debuggerApi.attach.getMockImplementation()!;
    current.debuggerApi.attach.mockImplementationOnce(() => {
      expect(current.entries.map(entry => entry.url)).toEqual(['http://example.test/before', 'https://example.test/current', 'about:blank']);
      attach();
    });
    await lease.send('Runtime.evaluate', { expression: 'history.go(-1)' });
    expect(current.contents.navigationHistory.removeEntryAtIndex).toHaveBeenNthCalledWith(1, 3);
    expect(current.contents.navigationHistory.removeEntryAtIndex).toHaveBeenNthCalledWith(2, 0);
    expect(current.contents.navigationHistory.getActiveIndex()).toBe(1);
    lease.close();
    expect(current.contents.loadURL).not.toHaveBeenCalled();
  });

  it.each(['file:///private/secret', 'chrome://gpu'])('refuses a lease on current unsupported URL %s without modifying it', async url => {
    const current = page(['https://example.test/', url]), lease = createPageProtocol(current.contents);
    await expect(lease.send('Runtime.evaluate', { expression: 'document.body.innerText' })).rejects.toThrow('navigation');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(current.contents.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
    lease.close();
  });

  it('fails closed if a forbidden history entry cannot be removed', async () => {
    const current = page(['file:///private/secret', 'https://example.test/']), lease = createPageProtocol(current.contents);
    vi.mocked(current.contents.navigationHistory.removeEntryAtIndex).mockReturnValue(false);
    await expect(lease.send('Runtime.evaluate')).rejects.toThrow('history');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('does not prune another debugger owner history', async () => {
    const current = page(['file:///private/secret', 'https://example.test/']);
    current.debuggerApi.attach();
    const lease = createPageProtocol(current.contents);
    await expect(lease.send('Runtime.enable')).rejects.toThrow('already in use');
    expect(current.contents.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled();
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('closes the lease if the person starts an unsupported main navigation, without closing their page', async () => {
    const current = page(), lease = createPageProtocol(current.contents), closed = vi.fn();
    lease.onClose(closed);
    await lease.send('Runtime.enable');
    current.contents.emit('did-start-navigation', { url: 'file:///private/secret', isMainFrame: false });
    expect(closed).not.toHaveBeenCalled();
    current.contents.emit('did-start-navigation', { url: 'https://example.test/next', isMainFrame: true });
    expect(closed).not.toHaveBeenCalled();
    current.contents.emit('did-start-navigation', { url: 'file:///private/secret', isMainFrame: true });
    await expect(lease.send('Runtime.evaluate')).rejects.toThrow('navigation');
    expect(closed).toHaveBeenCalledOnce();
    expect(current.contents.close).not.toHaveBeenCalled();
    expect(current.contents.listenerCount('did-start-navigation')).toBe(0);
  });

  it('uses only the selected native page after its viewport is ready, preserving navigation and focus', async () => {
    const first = page();
    let ready!: () => void;
    const lease = createPageProtocol(first.contents, { ready: new Promise(done => { ready = done; }) });
    const command = lease.send('Runtime.evaluate', { expression: 'document.title' });
    await new Promise(done => setImmediate(done));
    expect(first.debuggerApi.attach).not.toHaveBeenCalled();
    ready();
    await command;
    expect(first.debuggerApi.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: 'document.title' }, undefined);
    lease.close();
    expect(first.debuggerApi.detach).toHaveBeenCalledOnce();
    expect(first.contents.close).not.toHaveBeenCalled();
    expect(first.contents.loadURL).not.toHaveBeenCalled();
    expect(first.contents.focus).not.toHaveBeenCalled();
  });

  it.each([
    ['Browser.close', {}], ['Browser.getVersion', {}], ['SystemInfo.getInfo', {}],
    ['Target.getTargets', {}], ['Target.attachToTarget', { targetId: 'other' }],
    ['Target.getTargetInfo', { targetId: 'other' }], ['Target.closeTarget', { targetId: 'other' }],
    ['Target.sendMessageToTarget', { sessionId: 'other', message: '{}' }],
    ['Target.detachFromTarget', { sessionId: 'other' }], ['Target.setAutoAttach', { flatten: false }],
    ['Page.close', {}],
    ['Network.getAllCookies', {}], ['Network.getCookies', {}], ['Storage.getCookies', {}],
    ['Network.clearBrowserCookies', {}], ['Storage.clearDataForOrigin', { origin: 'https://other.test' }],
    ['Fetch.enable', {}], ['IO.read', { handle: 'other-task' }],
    ['Network.setCookies', { cookies: [] }], ['Unknown.futureMethod', {}],
  ])('refuses %s before touching the debugger', async (method, params) => {
    const current = page(), lease = createPageProtocol(current.contents);
    await expect(lease.send(method, params)).rejects.toThrow('not available');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it.each(['DOM.getFrameOwner', 'Input.setInterceptDrags', 'Input.dispatchDragEvent'])('allows page-scoped Playwright iframe/drag method %s', async method => {
    const current = page();
    const lease = createPageProtocol(current.contents);
    await expect(lease.send(method, {})).resolves.toBeDefined();
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledWith(method, {}, undefined);
    lease.close();
  });

  it.each(['chrome://gpu', 'devtools://devtools/bundled/inspector.html', 'file:///private/fixture', 'javascript:alert(1)', 'data:text/html,secret'])('rejects CDP navigation to %s before touching the debugger', async url => {
    const current = page(), lease = createPageProtocol(current.contents);
    await expect(lease.send('Page.navigate', { url })).rejects.toThrow('navigation');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it.each(['https://example.test/path', 'http://127.0.0.1:1234/', 'about:blank'])('preserves supported CDP navigation to %s', async url => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Page.navigate', { url });
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledWith('Page.navigate', { url }, undefined);
    lease.close();
  });

  it.each(['fi\nle:///private/fixture', 'chro\nme://gpu', 'devt\tools://devtools/bundled/inspector.html', '\0chrome://gpu', 'https://example.test/\rpath'])('rejects control characters in navigation URL %j before native dispatch', async url => {
    const current = page(), lease = createPageProtocol(current.contents);
    await expect(lease.send('Page.navigate', { url })).rejects.toThrow('navigation');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it.each(['chrome://gpu/', 'file:///private/fixture', 'devtools://devtools/bundled/inspector.html', 'chro\nme://gpu'])('refuses history navigation to %j after reading the target entry', async url => {
    const current = page(), lease = createPageProtocol(current.contents);
    current.debuggerApi.sendCommand.mockResolvedValue({ entries: [{ id: 17, url }] });
    await expect(lease.send('Page.navigateToHistoryEntry', { entryId: 17 })).rejects.toThrow('navigation');
    expect(current.debuggerApi.sendCommand.mock.calls).toEqual([['Page.getNavigationHistory', {}, undefined]]);
    lease.close();
  });

  it('checks the exact child history entry, permits supported history and refuses an unknown entry', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    await lease.send('Runtime.enable');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' });
    current.debuggerApi.sendCommand.mockClear();
    current.debuggerApi.sendCommand.mockResolvedValue({ entries: [{ id: 18, url: 'https://example.test/history' }] });
    await lease.send('Page.navigateToHistoryEntry', { entryId: 18 }, 'child');
    expect(current.debuggerApi.sendCommand.mock.calls).toEqual([
      ['Page.getNavigationHistory', {}, 'child'], ['Page.navigateToHistoryEntry', { entryId: 18 }, 'child'],
    ]);
    current.debuggerApi.sendCommand.mockClear();
    await expect(lease.send('Page.navigateToHistoryEntry', { entryId: 19 }, 'child')).rejects.toThrow('navigation');
    expect(current.debuggerApi.sendCommand.mock.calls).toEqual([['Page.getNavigationHistory', {}, 'child']]);
    lease.close();
  });

  it.each(['cancel', 'close', 'detach'])('does not navigate after %s while history lookup is pending', async action => {
    const current = page(), lease = createPageProtocol(current.contents), controller = new AbortController();
    await lease.send('Runtime.enable');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' });
    current.debuggerApi.sendCommand.mockClear();
    let finish!: (value: unknown) => void;
    current.debuggerApi.sendCommand.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = lease.send('Page.navigateToHistoryEntry', { entryId: 18 }, 'child', controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce());
    expect(current.debuggerApi.sendCommand.mock.calls[0]![0]).toBe('Page.getNavigationHistory');
    if (action === 'cancel') controller.abort();
    else if (action === 'close') lease.close();
    else current.debuggerApi.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'child' });
    finish({ entries: [{ id: 18, url: 'https://example.test/history' }] });
    await rejected;
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce();
    lease.close();
  });

  it.each([{ data: { files: ['/private/fixture'] } }, { files: ['/private/fixture'] }])('rejects local files in drag payload %j before native dispatch', async params => {
    const current = page(), lease = createPageProtocol(current.contents);
    await expect(lease.send('Input.dispatchDragEvent', params)).rejects.toThrow('files');
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('preserves ordinary text drag data and empty file lists', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    const params = { type: 'drop', x: 1, y: 2, data: { files: [], dragOperationsMask: 1, items: [{ mimeType: 'text/plain', data: 'safe' }] } };
    await lease.send('Input.dispatchDragEvent', params);
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledWith('Input.dispatchDragEvent', params, undefined);
    lease.close();
  });

  it('removes cookies from nested network headers and associated cookie metadata without mutating native events', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Network.enable');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' });
    heard.mockClear();
    const params = { requestId: 'request', request: { headers: { cOoKiE: 'secret=hidden', Accept: 'text/html' }, url: 'https://example.test/' },
      associatedCookies: [{ cookie: { name: 'secret', value: 'hidden', httpOnly: true } }] };
    current.debuggerApi.emit('message', {}, 'Network.requestWillBeSentExtraInfo', params, 'child');
    expect(heard).toHaveBeenCalledWith('Network.requestWillBeSentExtraInfo', {
      requestId: 'request', request: { headers: { Accept: 'text/html' }, url: 'https://example.test/' },
    }, 'child');
    expect(params.request.headers.cOoKiE).toBe('secret=hidden');
    expect(params.associatedCookies).toHaveLength(1);
    lease.close();
  });

  it('removes response cookie headers, raw header lines and blocked/exempted cookie details', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Network.enable');
    const params = { requestId: 'response', headers: { 'Set-Cookie': 'secret=hidden; HttpOnly', ETag: 'safe' },
      response: { headers: { 'set-cookie': 'secret=hidden', 'Content-Type': 'text/html' } },
      headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: secret=hidden;\r\n HttpOnly\r\nX-Public: safe\r\n',
      blockedCookies: [{ cookieLine: 'secret=hidden' }], exemptedCookies: [{ cookie: { value: 'hidden' } }] };
    current.debuggerApi.emit('message', {}, 'Network.responseReceivedExtraInfo', params);
    expect(heard).toHaveBeenCalledOnce();
    const delivered = heard.mock.calls[0]![1];
    expect(JSON.stringify(delivered)).not.toMatch(/secret|hidden|HttpOnly|cookie/i);
    expect(delivered).toMatchObject({ requestId: 'response', headers: { ETag: 'safe' }, response: { headers: { 'Content-Type': 'text/html' } } });
    expect(delivered).not.toHaveProperty('headersText');
    expect(params.headers['Set-Cookie']).toContain('hidden');
    lease.close();
  });

  it.each(['requestHeadersText', 'REQUESTHEADERSTEXT', 'responseHeadersText'])('removes nested WebSocket %s while preserving public structured headers', async key => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Network.enable');
    const params = { requestId: 'socket', response: { status: 101, headers: { Upgrade: 'websocket', 'Set-Cookie': 'private=hidden' },
      requestHeaders: { Cookie: 'private=hidden', Connection: 'Upgrade' }, [key]: 'GET /socket HTTP/1.1\r\nCookie: private=hidden\r\n' } };
    current.debuggerApi.emit('message', {}, 'Network.webSocketHandshakeResponseReceived', params);
    expect(heard).toHaveBeenCalledWith('Network.webSocketHandshakeResponseReceived', {
      requestId: 'socket', response: { status: 101, headers: { Upgrade: 'websocket' }, requestHeaders: { Connection: 'Upgrade' } },
    }, undefined);
    expect(params.response[key]).toContain('private=hidden');
    lease.close();
  });

  it('delivers native attachment events before the first command without dropping synchronous events', async () => {
    const current = page(), heard = vi.fn();
    const attach = current.debuggerApi.attach.getMockImplementation()!;
    current.debuggerApi.attach.mockImplementationOnce(() => {
      attach();
      current.debuggerApi.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 7 } });
    });
    const lease = createPageProtocol(current.contents);
    lease.onMessage(heard);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('Runtime.executionContextCreated', { context: { id: 7 } }, undefined));
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('refuses a second lease without disturbing the first and permits a fresh lease after release', async () => {
    const current = page(), first = createPageProtocol(current.contents);
    await first.send('Runtime.enable');
    const second = createPageProtocol(current.contents);
    await expect(second.send('Runtime.enable')).rejects.toThrow('already in use');
    second.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
    await first.send('Input.insertText', { text: 'still owned by first' });
    expect(current.debuggerApi.sendCommand).toHaveBeenLastCalledWith('Input.insertText', { text: 'still owned by first' }, undefined);
    first.close();
    const next = createPageProtocol(current.contents);
    await next.send('Runtime.enable');
    expect(current.debuggerApi.attach).toHaveBeenCalledTimes(2);
    next.close();
  });

  it('accepts only child sessions announced by this page and forgets detached descendants', async () => {
    const current = page(), lease = createPageProtocol(current.contents), heard = vi.fn();
    lease.onMessage(heard);
    await lease.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    current.debuggerApi.emit('message', {}, 'Runtime.consoleAPICalled', {}, 'foreign');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'stolen' }, 'foreign');
    expect(heard).not.toHaveBeenCalled();
    await expect(lease.send('Runtime.evaluate', {}, 'stolen')).rejects.toThrow('unknown page session');
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child' });
    current.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'grandchild' }, 'child');
    await lease.send('Runtime.evaluate', {}, 'grandchild');
    expect(current.debuggerApi.sendCommand).toHaveBeenLastCalledWith('Runtime.evaluate', {}, 'grandchild');
    current.debuggerApi.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'child' });
    await expect(lease.send('Runtime.evaluate', {}, 'grandchild')).rejects.toThrow('unknown page session');
    lease.close();
  });

  it('cancels commands still waiting for a viewport without attaching or closing the page', async () => {
    const current = page(), controller = new AbortController();
    const lease = createPageProtocol(current.contents, { signal: controller.signal, ready: new Promise(() => {}) });
    const result = expect(lease.send('Input.insertText', { text: 'never sent' })).rejects.toThrow('cancelled');
    controller.abort();
    await result;
    expect(current.debuggerApi.attach).not.toHaveBeenCalled();
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    expect(current.contents.close).not.toHaveBeenCalled();
  });

  it('releases an in-flight caller on cancellation and never replays an uncertain native command', async () => {
    const current = page(), controller = new AbortController(), closed = vi.fn();
    let complete!: () => void;
    current.debuggerApi.sendCommand.mockImplementationOnce(() => new Promise(done => { complete = () => done({ late: true }); }));
    const lease = createPageProtocol(current.contents, { signal: controller.signal });
    lease.onClose(closed);
    const pending = lease.send('Input.insertText', { text: 'once' });
    const result = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce());
    controller.abort();
    await result;
    complete();
    await expect(lease.send('Input.insertText', { text: 'again' })).rejects.toThrow('cancelled');
    expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce();
    expect(current.debuggerApi.detach).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('cancels one native command without detaching the lease or failing concurrent commands', async () => {
    const current = page(), controller = new AbortController(), closed = vi.fn();
    let finishA!: () => void, finishB!: () => void;
    current.debuggerApi.sendCommand.mockImplementation((_method, params) => new Promise(resolve => {
      const done = () => resolve({ value: (params as { expression: string }).expression });
      if ((params as { expression: string }).expression === 'a') finishA = done; else finishB = done;
    }));
    const lease = createPageProtocol(current.contents); lease.onClose(closed);
    const a = lease.send('Runtime.evaluate', { expression: 'a' }, undefined, controller.signal);
    const rejected = expect(a).rejects.toBeDefined();
    const b = lease.send('Runtime.evaluate', { expression: 'b' });
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledTimes(2));
    controller.abort(); await rejected;
    finishB(); await expect(b).resolves.toEqual({ value: 'b' });
    finishA();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(lease.attached).toBe(true);
    lease.close();
  });

  it('borrows captures from the native rendering owner', async () => {
    const current = page(), capture = vi.fn(async () => ({ data: 'frame' }));
    const lease = createPageProtocol(current.contents, { capture });
    const params = { format: 'png', clip: { x: 2, y: 3, width: 10, height: 20, scale: 1 } };
    await expect(lease.send('Page.captureScreenshot', params)).resolves.toEqual({ data: 'frame' });
    expect(capture).toHaveBeenCalledWith(params);
    expect(current.debuggerApi.sendCommand).not.toHaveBeenCalled();
    lease.close();
  });

  it('does not steal or detach another debugger owner', async () => {
    const current = page();
    current.debuggerApi.attach();
    const lease = createPageProtocol(current.contents);
    await expect(lease.send('Runtime.enable')).rejects.toThrow('already in use');
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('settles in-flight commands on native destruction without touching the destroyed debugger', async () => {
    const current = page(), lease = createPageProtocol(current.contents);
    current.debuggerApi.sendCommand.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(lease.send('Runtime.enable')).rejects.toThrow('tab was closed');
    await vi.waitFor(() => expect(current.debuggerApi.sendCommand).toHaveBeenCalledOnce());
    current.destroy();
    await pending;
    lease.close();
    expect(current.debuggerApi.detach).not.toHaveBeenCalled();
    expect(current.debuggerApi.listenerCount('message')).toBe(0);
    expect(current.debuggerApi.listenerCount('detach')).toBe(0);
  });
});
