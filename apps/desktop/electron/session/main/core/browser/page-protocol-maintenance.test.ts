import { expect, it } from 'vitest';
import { createPageProtocol } from './page-protocol';
import { leasePageProtocol } from './leased-page-protocol';
import { page } from './test-support/page-protocol-fixture';

const defaults = { media: '', features: [
  { name: 'prefers-color-scheme', value: 'light' },
  { name: 'prefers-reduced-motion', value: 'no-preference' },
  { name: 'forced-colors', value: 'none' },
  { name: 'prefers-contrast', value: 'no-preference' },
] };

it('maintains a native-owned child session without attributing its initialization to a tool call', async () => {
  const native = page();
  native.debuggerApi.sendCommand.mockImplementation(async method => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'known-frame' } } } : { ok: true });
  const protocol = createPageProtocol(native.contents);
  try {
    await protocol.maintain!('Page.enable');
    native.debuggerApi.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-session' });
    const commands: [string, Record<string, unknown>?][] = [
      ['Page.enable'], ['Page.getFrameTree'], ['Log.enable', {}], ['Page.setLifecycleEventsEnabled', { enabled: true }],
      ['Runtime.enable', {}], ['Page.addScriptToEvaluateOnNewDocument', { source: '', worldName: 'app-utility-world' }],
      ['Network.enable'], ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
      ['Emulation.setEmulatedMedia', defaults], ['Runtime.runIfWaitingForDebugger'],
      ['Page.createIsolatedWorld', { frameId: 'known-frame', worldName: 'app-utility-world', grantUniveralAccess: true }],
    ];
    for (const [method, params] of commands) await protocol.maintain!(method, params, 'child-session');
    expect(native.debuggerApi.sendCommand).toHaveBeenCalledWith('Page.createIsolatedWorld',
      { frameId: 'known-frame', worldName: 'app-utility-world', grantUniveralAccess: true }, 'child-session');
    expect(native.debuggerApi.sendCommand.mock.calls.every(([method]) => !method.startsWith('Input.') && method !== 'Runtime.evaluate')).toBe(true);
  } finally { protocol.close(); }
});

it('rejects actions, scripts, file paths and altered initialization parameters before native dispatch', async () => {
  const native = page(), protocol = createPageProtocol(native.contents);
  try {
    for (const [method, params] of [
      ['Input.insertText', { text: 'action' }], ['Page.navigate', { url: 'https://example.test' }],
      ['Runtime.evaluate', { expression: 'document.body.click()' }], ['Runtime.callFunctionOn', { functionDeclaration: '()=>1' }],
      ['DOM.setFileInputFiles', { files: ['/private/fixture'] }], ['Page.handleJavaScriptDialog', { accept: true }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: 'document.body.click()', worldName: 'app' }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, targetId: 'other-page' }],
      ['Network.enable', { arbitrary: 'parameter' }], ['Browser.getVersion', {}],
      ['Emulation.setEmulatedMedia', { ...defaults, media: 'print' }],
      ['Emulation.setEmulatedMedia', { media: '', features: [{ name: '__proto__', value: 'x' }] }],
    ] as [string, Record<string, unknown>][]) await expect(protocol.maintain!(method, params)).rejects.toThrow('not connection maintenance');
    expect(native.debuggerApi.sendCommand).not.toHaveBeenCalled();
  } finally { protocol.close(); }
});

it('checks frame identity against the native tree and refuses unknown child sessions', async () => {
  const native = page();
  native.debuggerApi.sendCommand.mockResolvedValue({ frameTree: { frame: { id: 'real-frame' } } });
  const protocol = createPageProtocol(native.contents);
  try {
    await expect(protocol.maintain!('Page.createIsolatedWorld', { frameId: 'forged-frame', worldName: 'app' })).rejects.toThrow('Unknown frame');
    expect(native.debuggerApi.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.getFrameTree']);
    await expect(protocol.maintain!('Runtime.enable', {}, 'forged-session')).rejects.toThrow('unknown page session');
    protocol.close();
    await expect(protocol.maintain!('Runtime.enable')).rejects.toThrow('closed');
  } finally { protocol.close(); }
});

it('fences maintenance queued behind native restoration when the lease ends', async () => {
  const native = page(), ready = Promise.withResolvers<void>();
  const leased = leasePageProtocol(native.contents, { ready: ready.promise, capture: async () => ({}) });
  const pending = leased.protocol.maintain!('Page.enable');
  const rejected = expect(pending).rejects.toThrow();
  await leased.cleanup(); ready.resolve(); await rejected;
  expect(native.debuggerApi.sendCommand).not.toHaveBeenCalled();
  leased.protocol.close();
});
