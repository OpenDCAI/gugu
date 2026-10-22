import { describe, expect, it } from 'vitest';
import { isProtectedMacDirectory } from './session-permission-hint';

describe('macOS startup permission hint scope', () => {
  it.each(['Documents', 'Desktop', 'Downloads'])('includes %s itself and its projects', (folder) => {
    expect(isProtectedMacDirectory('darwin', '/Users/test', `/Users/test/${folder}`)).toBe(true);
    expect(isProtectedMacDirectory('darwin', '/Users/test/', `/Users/test/${folder}/Project`)).toBe(true);
  });
  it.each([
    ['linux', '/Users/test', '/Users/test/Documents/Project'],
    ['win32', 'C:/Users/test', 'C:/Users/test/Documents/Project'],
    ['darwin', '/Users/test', '/Users/another/Documents/Project'],
    ['darwin', '/Users/test', '/Users/test/Documents-old/Project'],
    ['darwin', '/Users/test', '/Users/test/Documents/../code'],
    ['darwin', '/Users/test', '/Users/test/code'],
  ])('does not hint outside the approved scope (%s, %s, %s)', (platform, home, cwd) => {
    expect(isProtectedMacDirectory(platform, home, cwd)).toBe(false);
  });
});
