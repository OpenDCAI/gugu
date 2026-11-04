import { describe, expect, it } from 'vitest';
import { TerminalOutput } from './terminal-output';

describe('TerminalOutput.text()', () => {
  it('keeps the per-limit memo honest across append, trim and reset', () => {
    const output = new TerminalOutput(16);
    output.append(Buffer.from('aaaa'));
    expect(output.text()).toBe('aaaa');
    output.append(Buffer.from('bbbb'));
    expect(output.text()).toBe('aaaabbbb');
    output.append(Buffer.from('cccc'));
    expect(output.text()).toBe('aaaabbbbcccc');
    output.trimTo(4);
    expect(output.text()).toBe('cccc');
    output.append(Buffer.from('eeee'));
    expect(output.text()).toBe('cccceeee');
    expect(output.text(4)).toBe('eeee');
    output.reset(Buffer.from('dd'));
    expect(output.text()).toBe('dd');
  });
});
