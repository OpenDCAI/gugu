import { describe, expect, it } from 'vitest';
import { loginCallbackPorts, mergePortRows, parsePortInput } from './remote-ports-model';

describe('the Ports tab (VS Code Ports view)', () => {
  it('merges forwarded, found-in-output and listening ports into one row per port', () => {
    const rows = mergePortRows(
      {
        forwards: [
          { deviceId: 'd', remotePort: 8000, phase: 'ready', localPort: 8000, prompt: null, reason: null, label: 'box', holders: ['browser-1', 'manual'] },
          { deviceId: 'd', remotePort: 1455, phase: 'connecting', localPort: null, prompt: null, reason: null, label: 'box', holders: ['login:req-1'] },
        ],
        detected: [
          { remotePort: 5173, sessionId: 'c1', source: 'terminal', at: 1 },
          { remotePort: 8000, sessionId: 'c2', source: 'agent', at: 2 },
        ],
      },
      [{ port: 5173, process: 'node' }, { port: 6379 }]
    );
    expect(rows).toEqual([
      { remotePort: 1455, localPort: null, state: 'connecting', sources: ['login'], process: null, sessionId: null },
      { remotePort: 5173, localPort: null, state: 'idle', sources: ['terminal', 'listening'], process: 'node', sessionId: 'c1' },
      { remotePort: 6379, localPort: null, state: 'idle', sources: ['listening'], process: null, sessionId: null },
      { remotePort: 8000, localPort: 8000, state: 'ready', sources: ['agent', 'browser', 'manual'], process: null, sessionId: 'c2' },
    ]);
  });

  it('reads what people type into the forward box', () => {
    expect(parsePortInput(' 3000 ')).toBe(3000);
    expect(parsePortInput('localhost:5173')).toBe(5173);
    expect(parsePortInput('http://127.0.0.1:8000/')).toBe(8000);
    expect(parsePortInput('0')).toBeNull();
    expect(parsePortInput('70000')).toBeNull();
    expect(parsePortInput('abc')).toBeNull();
  });
});

describe('sign-in pages that come back to a localhost port (VS Code 1.88 port forwarding in query)', () => {
  it('finds the callback port in the query or fragment', () => {
    expect(
      loginCallbackPorts(
        'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s'
      )
    ).toEqual([1455]);
    expect(loginCallbackPorts('https://example.com/login#next=http://127.0.0.1:8765/done')).toEqual([8765]);
    expect(loginCallbackPorts('https://github.com/login/device')).toEqual([]);
    expect(loginCallbackPorts('not a url')).toEqual([]);
  });
});
