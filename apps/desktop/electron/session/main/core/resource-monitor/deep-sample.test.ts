import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, contentTracing: {} }));

describe('summarizeMemoryDumps', () => {
  it('keeps the last dump per pid and reads hex byte sizes', async () => {
    const { summarizeMemoryDumps } = await import('./deep-sample');
    const dump = (pid: number, blinkGc: string, footprint?: string) => ({
      ph: 'v',
      pid,
      args: {
        dumps: {
          ...(footprint ? { process_totals: { private_footprint_bytes: footprint } } : {}),
          allocators: { blink_gc: { attrs: { size: { value: blinkGc } } }, v8: { attrs: { size: { value: '400' } } } },
        },
      },
    });
    const rows = summarizeMemoryDumps([
      dump(9, '100', 'a00'),
      { ph: 'X', pid: 9 },
      dump(3, '10'),
      dump(9, '200'),
    ]);
    expect(rows).toEqual([
      { pid: 3, allocators: { blink_gc: 0x10, v8: 0x400 } },
      { pid: 9, privateFootprintBytes: 0xa00, allocators: { blink_gc: 0x200, v8: 0x400 } },
    ]);
  });
});
