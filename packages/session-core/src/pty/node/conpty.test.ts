import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { releaseConoutWorkerOnExit } from './conpty';

function fakePty() {
  let exit: (() => void) | undefined;
  const dispose = vi.fn();
  const proc = {
    onExit: vi.fn((listener: () => void) => {
      exit = listener;
    }),
    _agent: { _conoutSocketWorker: { dispose } },
  };
  return { proc, dispose, fireExit: () => exit?.() };
}

describe('releaseConoutWorkerOnExit (#6629)', () => {
  it('hands the conout worker back when the Windows pty exits', () => {
    const { proc, dispose, fireExit } = fakePty();
    releaseConoutWorkerOnExit(proc, 'win32');
    expect(dispose).not.toHaveBeenCalled();
    fireExit();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does nothing off Windows, and tolerates the winpty branch that has no worker', () => {
    const { proc, dispose } = fakePty();
    releaseConoutWorkerOnExit(proc, 'darwin');
    expect(proc.onExit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    let exit: (() => void) | undefined;
    releaseConoutWorkerOnExit({ onExit: (l: () => void) => (exit = l), _agent: {} }, 'win32');
    expect(() => exit?.()).not.toThrow();
  });
});

// 钉住上面那个私有形状与「为什么要补」—— 读的是已装的 node-pty 源码,平台无关。
// node-pty 升级改了其中任何一条,这里先红:要么字段换了名(补丁静默失效),要么上游已修(补丁可以删)。
describe('installed node-pty still needs the release (#6629)', () => {
  const lib = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'lib');
  const agent = readFileSync(join(lib, 'windowsPtyAgent.js'), 'utf8');
  const terminal = readFileSync(join(lib, 'windowsTerminal.js'), 'utf8');
  const conout = readFileSync(join(lib, 'windowsConoutConnection.js'), 'utf8');
  const bodyOf = (source: string, head: string) => {
    const start = source.indexOf(head);
    if (start < 0) throw new Error(`not found: ${head}`);
    return source.slice(start, source.indexOf('\n    };', start));
  };

  it('the worker lives at _agent._conoutSocketWorker and exit is emitted when the output socket closes', () => {
    expect(terminal).toMatch(/_this\._agent = new windowsPtyAgent_1\.WindowsPtyAgent\(/);
    expect(agent).toMatch(/this\._conoutSocketWorker = new windowsConoutConnection_1\.ConoutConnection\(/);
    expect(bodyOf(terminal, "_this._socket.on('close'")).toContain("_this.emit('exit'");
    expect(bodyOf(conout, 'ConoutConnection.prototype._destroySocket')).toContain('this._worker.terminate()');
  });

  it('with useConptyDll, process exit never disposes the worker and kill only does so on later output', () => {
    const onExit = bodyOf(agent, 'WindowsPtyAgent.prototype._$onProcessExit');
    expect(onExit).toMatch(/if \(!this\._useConptyDll\) \{/);
    expect(onExit).not.toMatch(/\}\s*else/);
    const kill = bodyOf(agent, 'WindowsPtyAgent.prototype.kill');
    expect(kill).toMatch(/this\._outSocket\.on\('data', function \(\) \{\s*_this\._conoutSocketWorker\.dispose\(\);\s*\}\);/);
  });
});
