import { describe, expect, it } from 'vitest';
import { createPortDetector, findLoopbackPorts } from './remote-port-detect';

describe('finding the ports a program on that machine says it listens on (VS Code output source)', () => {
  it('reads the usual dev-server lines, colors and all', () => {
    expect(findLoopbackPorts('  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toEqual([5173]);
    expect(findLoopbackPorts('Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)')).toEqual([8000]);
    expect(findLoopbackPorts('Serving HTTP on 0.0.0.0 port 8080 (http://0.0.0.0:8080/) ...')).toEqual([8080]);
    expect(findLoopbackPorts('listening on [::1]:3000 and localhost:3000')).toEqual([3000]);
    expect(findLoopbackPorts('see http://example.com:8080 and mylocalhost:9000 and 10.0.0.1:22')).toEqual([]);
    expect(findLoopbackPorts('http://localhost/')).toEqual([]);
    // Output cut short with an ellipsis is not a port.
    expect(findLoopbackPorts('"output":"Serving on http://localhost:87…"')).toEqual([]);
    expect(findLoopbackPorts('see localhost:87...')).toEqual([]);
  });

  it('joins a URL cut across two chunks and reports each port only once', () => {
    const detector = createPortDetector();
    expect(detector.push('ready - started server on http://local')).toEqual([]);
    expect(detector.push('host:3000, url: http://localhost:3000')).toEqual([3000]);
    expect(detector.push('GET http://localhost:3000/api')).toEqual([]);
  });

  // d22 实撞:端口表里一行「87」—— 输出在 `localhost:87` 处被切成两段,前一段当场报了 87。
  it('never reports a port number that a chunk boundary cut in half', () => {
    const detector = createPortDetector();
    expect(detector.push('Serving at http://localhost:87')).toEqual([]);
    expect(detector.push('65/\r\n')).toEqual([8765]);
    // Also when split right after the colon, or with colour codes around the split.
    const other = createPortDetector();
    expect(other.push('open http://127.0.0.1:')).toEqual([]);
    expect(other.push('\x1b[1m5173\x1b[0m ready')).toEqual([5173]);
  });
});
