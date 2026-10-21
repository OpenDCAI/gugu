import { describe, expect, it, vi } from 'vitest';
import { createDetectedPorts, MAX_DETECTED_PER_DEVICE } from './detected-ports';

describe('ports found in terminal / agent output', () => {
  it('records each port once per machine, announces only new ones, and stays bounded', () => {
    const onChanged = vi.fn();
    const onDetected = vi.fn();
    const table = createDetectedPorts({ now: () => 7, onChanged, onDetected });
    table.detect('d1', 'c1', [5173, 8000], 'terminal');
    table.detect('d1', 'c2', [8000], 'agent');
    expect(onDetected).toHaveBeenCalledTimes(2);
    expect(onDetected).toHaveBeenCalledWith({ deviceId: 'd1', remotePort: 5173, sessionId: 'c1', source: 'terminal', at: 7 });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(table.list('d1').map((p) => p.remotePort)).toEqual([5173, 8000]);
    table.forget('d1', 5173);
    expect(table.list('d1').map((p) => p.remotePort)).toEqual([8000]);
    for (let port = 10_000; port < 10_000 + MAX_DETECTED_PER_DEVICE + 5; port++) table.detect('d2', 'c', [port], 'terminal');
    expect(table.list('d2')).toHaveLength(MAX_DETECTED_PER_DEVICE);
    expect(table.list('d2')[0]!.remotePort).toBe(10_005);
  });
});
