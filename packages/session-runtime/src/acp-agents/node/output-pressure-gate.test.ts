import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { outputPressureGate } from './output-pressure-gate';

it('does not let the ACP stream pull override IPC pressure, or override the stream own pause on release', () => {
  const source = new PassThrough();
  const pressure = outputPressureGate(source);
  source.resume();
  pressure(true);
  source.resume(); // The web stream asks for another read while IPC is still blocked.
  expect(source.isPaused()).toBe(true);
  pressure(false);
  expect(source.isPaused()).toBe(false);
  pressure(true);
  source.pause(); // The web stream no longer wants input.
  pressure(false);
  expect(source.isPaused()).toBe(true);
  source.destroy();
});
