import { describe, expect, it } from 'vitest';
import { createMachinePortScanner, type PortReport } from './machine-port-scanner';

const P = '11111111-aaaa-4bbb-8ccc-000000000001';
const T = '22222222-aaaa-4bbb-8ccc-000000000002';
const C = '33333333-aaaa-4bbb-8ccc-000000000003';

function scanner(options: { browser?: boolean; machine?: string | null } = {}) {
  const reports: PortReport[] = [];
  const machine = options.machine === undefined ? 'dev-a' : options.machine;
  const s = createMachinePortScanner({
    machineOf: (id) => (id.startsWith(P) ? machine : null),
    hasBrowser: () => options.browser ?? true,
    report: (found) => reports.push(found),
  });
  return { s, reports };
}

describe('别的机器上的会话输出里认出端口(#6264,照 VS Code 的 output 来源)', () => {
  it('终端输出:报那台机器、那条会话、端口,每条输出流里同一个端口只报一次', () => {
    const { s, reports } = scanner();
    s.onPtyOutput(`${P}:${T}:${C}`, '  ➜  Local:   http://localhost:5173/\r\n');
    s.onPtyOutput(`${P}:${T}:${C}`, 'again http://localhost:5173/\r\n');
    expect(reports).toEqual([{ deviceId: 'dev-a', sessionId: C, ports: [5173], source: 'terminal' }]);
  });

  it('端口号被切在两段输出之间也认得出', () => {
    const { s, reports } = scanner();
    s.onPtyOutput(`${P}:${T}:${C}`, 'Serving HTTP on 0.0.0.0 port 87');
    s.onPtyOutput(`${P}:${T}:${C}`, '65 (http://0.0.0.0:8765/) ...\r\n');
    expect(reports.flatMap((r) => r.ports)).toEqual([8765]);
  });

  it('聊天会话刚提交的那一轮里提到的端口', () => {
    const { s, reports } = scanner();
    s.onCommittedTurn({ projectId: P, sessionId: C }, { blocks: [{ text: '已在 localhost:3000 跑起来了' }] });
    expect(reports).toEqual([{ deviceId: 'dev-a', sessionId: C, ports: [3000], source: 'agent' }]);
  });

  it('本机的会话、没有浏览器格的机器(只经咕咕云连着):一概不报', () => {
    const local = scanner({ machine: null });
    local.s.onPtyOutput(`${P}:${T}:${C}`, 'http://localhost:5173/');
    local.s.onCommittedTurn({ projectId: P, sessionId: C }, 'localhost:3000');
    expect(local.reports).toEqual([]);
    const tunnel = scanner({ browser: false });
    tunnel.s.onPtyOutput(`${P}:${T}:${C}`, 'http://localhost:5173/');
    expect(tunnel.reports).toEqual([]);
  });
});

describe('报之前按进程核实(#6264,照 VS Code 的 hybrid 来源)', () => {
  function verified(ownPorts: (deviceId: string) => Promise<readonly number[] | null>) {
    const reports: PortReport[] = [];
    const asked: string[] = [];
    const s = createMachinePortScanner({
      machineOf: (id) => (id.startsWith(P) ? 'dev-a' : null),
      hasBrowser: () => true,
      report: (found) => reports.push(found),
      ownPorts: (deviceId) => (asked.push(deviceId), ownPorts(deviceId)),
    });
    return { s, reports, asked };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const turn = (text: string) => ({ blocks: [{ text }] });
  const target = { projectId: P, sessionId: C };

  it('咕咕自己的端口(/mcp 里的 127.0.0.1:35979)丢掉,普通端口照报;同一端口只核一次', async () => {
    const { s, reports, asked } = verified(async () => [35979]);
    s.onCommittedTurn(target, turn('MCP http://127.0.0.1:35979/mcp,服务在 localhost:5173'));
    await flush();
    s.onCommittedTurn(target, turn('再看 http://127.0.0.1:35979 与 localhost:5173'));
    await flush();
    expect(reports.map((r) => r.ports)).toEqual([[5173], [5173]]);
    expect(asked).toEqual(['dev-a']);
  });

  it('核不了(旧版 server 没有这一项 / 调用失败)照报', async () => {
    const old = verified(async () => null);
    old.s.onPtyOutput(`${P}:${T}:${C}`, 'http://127.0.0.1:35979/\r\n');
    const failed = verified(() => Promise.reject(new Error('offline')));
    failed.s.onPtyOutput(`${P}:${T}:${C}`, 'http://127.0.0.1:35979/\r\n');
    await flush();
    expect(old.reports.flatMap((r) => r.ports)).toEqual([35979]);
    expect(failed.reports.flatMap((r) => r.ports)).toEqual([35979]);
  });
});
