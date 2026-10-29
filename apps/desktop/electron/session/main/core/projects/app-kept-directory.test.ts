import { describe, expect, it } from 'vitest';


import { isAppKeptDirectory } from './app-kept-directory';

const dirs = { home: '/home/ada', guguHome: '/home/ada/.gugu', taskHome: '/data/gugu/task-home' };

describe('isAppKeptDirectory (#609)', () => {
  it('~, the task-home and everything under GUGU_HOME are the app\'s own directories', () => {
    expect(isAppKeptDirectory('/home/ada', dirs)).toBe(true);
    expect(isAppKeptDirectory('/home/ada/', dirs)).toBe(true);
    expect(isAppKeptDirectory('/data/gugu/task-home', dirs)).toBe(true);
    expect(isAppKeptDirectory('/home/ada/.gugu/assistant-workdir', dirs)).toBe(true);
  });

  it('a folder the person works in is not, even inside ~', () => {
    expect(isAppKeptDirectory('/home/ada/code/gugu', dirs)).toBe(false);
    expect(isAppKeptDirectory('/home/ada/.gugu-other', dirs)).toBe(false);
    expect(isAppKeptDirectory('/home', dirs)).toBe(false);
  });
});
